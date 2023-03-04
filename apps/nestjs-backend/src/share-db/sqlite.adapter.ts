import { Injectable } from '@nestjs/common';
import type {
  IOtOperation,
  IRecord,
  ISetRecordOrderOpContext,
  ISetColumnMetaOpContext,
  IFieldSnapshot,
  IRecordSnapshot,
  ISetRecordOpContext,
  IAddColumnMetaOpContext,
  IRecordSnapshotQuery,
  IFieldSnapshotQuery,
  IAggregateQuery,
  ISetFieldNameOpContext,
  ISnapshotQuery,
  IViewSnapshot,
  ViewType,
  ISnapshotBase,
  ITableSnapshot,
} from '@teable-group/core';
import { AggregateKey, SnapshotQueryType, IdPrefix, OpName, OpBuilder } from '@teable-group/core';
import type { Prisma } from '@teable-group/db-main-prisma';
import { instanceToPlain } from 'class-transformer';
import { groupBy } from 'lodash';
import type { CreateOp, DeleteOp, EditOp } from 'sharedb';
import ShareDb from 'sharedb';
import type { SnapshotMeta } from 'sharedb/lib/sharedb';
import { FieldService } from '../features/field/field.service';
import { createFieldInstanceByRaw } from '../features/field/model/factory';
import type { FieldVo } from '../features/field/model/field.vo';
import { RecordService } from '../features/record/record.service';
import { TableService } from '../features/table/table.service';
import { ViewService } from '../features/view/view.service';
import { TransactionService } from './transaction.service';

export interface ICollectionSnapshot {
  type: string;
  v: number;
  data: IRecord;
}

type IProjection = { [fieldKey: string]: boolean };

@Injectable()
export class SqliteDbAdapter extends ShareDb.DB {
  closed: boolean;

  constructor(
    private readonly tableService: TableService,
    private readonly recordService: RecordService,
    private readonly fieldService: FieldService,
    private readonly viewService: ViewService,
    private readonly transactionService: TransactionService
  ) {
    super();
    this.closed = false;
  }

  query = async (
    collection: string,
    query: IRecordSnapshotQuery | IFieldSnapshotQuery | IAggregateQuery,
    projection: IProjection,
    options: unknown,
    callback: ShareDb.DBQueryCallback
  ) => {
    console.log(`query: ${collection}`);
    this.queryPoll(collection, query, options, (error, results) => {
      // console.log('query pull result: ', ids);
      if (error) {
        return callback(error, []);
      }
      this.getSnapshotBulk(
        collection,
        results as string[],
        projection,
        options,
        (error, snapshots) => {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          callback(error, snapshots!);
        }
      );
    });
  };

  // return a specific id for row count fetch
  private async getAggregateIds(
    prisma: Prisma.TransactionClient,
    collection: string,
    query: IAggregateQuery
  ) {
    let viewId = query.viewId;
    if (!viewId) {
      const view = await prisma.view.findFirstOrThrow({
        where: { tableId: collection },
        select: { id: true },
      });
      viewId = view.id;
    }
    return [`${query.aggregateKey}_${viewId}`];
  }

  async queryPoll(
    collection: string,
    query: ISnapshotQuery,
    options: unknown,
    callback: (error: ShareDb.Error | null, ids: string[]) => void
  ) {
    try {
      const prisma = this.transactionService.get(collection);

      if (query.type === SnapshotQueryType.Field) {
        const ids = await this.fieldService.getFieldIds(prisma, collection, query);
        callback(null, ids);
        return;
      }

      if (query.type === SnapshotQueryType.Record) {
        const ids = await this.recordService.getRecordIds(prisma, collection, query);
        callback(null, ids);
        return;
      }

      if (query.type === SnapshotQueryType.View) {
        const ids = await this.viewService.getViewIds(prisma, collection);
        callback(null, ids);
        return;
      }

      if (query.type === SnapshotQueryType.Aggregate) {
        const ids = await this.getAggregateIds(prisma, collection, query);
        callback(null, ids);
        return;
      }
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callback(e as any, []);
    }
  }

  // Return true to avoid polling if there is no possibility that an op could
  // affect a query's results
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  skipPoll(
    _collection: string,
    _id: string,
    op: CreateOp | DeleteOp | EditOp,
    _query: IRecordSnapshotQuery
  ): boolean {
    // ShareDB is in charge of doing the validation of ops, so at this point we
    // should be able to assume that the op is structured validly
    if (op.create || op.del) return false;
    return !op.op;
  }

  close(callback: () => void) {
    this.closed = true;

    if (callback) callback();
  }

  private async setRecordOrder(
    prisma: Prisma.TransactionClient,
    version: number,
    recordId: string,
    dbTableName: string,
    contexts: ISetRecordOrderOpContext[]
  ) {
    for (const context of contexts) {
      const { viewId, newOrder } = context;
      await this.recordService.setRecordOrder(
        prisma,
        version,
        recordId,
        dbTableName,
        viewId,
        newOrder
      );
    }
  }

  private async setRecords(
    prisma: Prisma.TransactionClient,
    version: number,
    recordId: string,
    dbTableName: string,
    contexts: ISetRecordOpContext[]
  ) {
    return await this.recordService.setRecord(prisma, version, recordId, dbTableName, contexts);
  }

  private async addField(
    prisma: Prisma.TransactionClient,
    tableId: string,
    snapshot: IFieldSnapshot
  ) {
    await this.fieldService.addField(prisma, tableId, snapshot);
  }

  private async addView(
    prisma: Prisma.TransactionClient,
    tableId: string,
    snapshot: IViewSnapshot
  ) {
    await this.viewService.addView(prisma, tableId, snapshot);
  }

  private async addRecord(prisma: Prisma.TransactionClient, tableId: string, recordId: string) {
    await this.recordService.addRecord(prisma, tableId, recordId);
  }

  private async addTable(prisma: Prisma.TransactionClient, snapshot: ITableSnapshot) {
    await this.tableService.addTable(prisma, snapshot);
  }

  private async addColumnMeta(
    prisma: Prisma.TransactionClient,
    version: number,
    fieldId: string,
    contexts: IAddColumnMetaOpContext[]
  ) {
    for (const context of contexts) {
      const { viewId, newMetaValue } = context;

      const fieldData = await prisma.field.findUniqueOrThrow({
        where: { id: fieldId },
        select: { columnMeta: true },
      });

      const columnMeta = JSON.parse(fieldData.columnMeta);

      Object.entries(newMetaValue).forEach(([key, value]) => {
        columnMeta[viewId][key] = value;
      });

      await prisma.field.update({
        where: { id: fieldId },
        data: { columnMeta: JSON.stringify(columnMeta), version },
      });
    }
  }

  private async setColumnMeta(
    prisma: Prisma.TransactionClient,
    version: number,
    fieldId: string,
    contexts: ISetColumnMetaOpContext[]
  ) {
    for (const context of contexts) {
      const { metaKey, viewId, newMetaValue } = context;

      const fieldData = await prisma.field.findUniqueOrThrow({
        where: { id: fieldId },
        select: { columnMeta: true },
      });

      const columnMeta = JSON.parse(fieldData.columnMeta);

      columnMeta[viewId][metaKey] = newMetaValue;

      await prisma.field.update({
        where: { id: fieldId },
        data: { columnMeta: JSON.stringify(columnMeta), version },
      });
    }
  }

  private async setFieldName(
    prisma: Prisma.TransactionClient,
    version: number,
    fieldId: string,
    contexts: ISetFieldNameOpContext[]
  ) {
    for (const context of contexts) {
      const { newName } = context;
      await prisma.field.update({
        where: { id: fieldId },
        data: { name: newName, version },
      });
    }
  }

  private async updateSnapshot(
    prisma: Prisma.TransactionClient,
    version: number,
    collection: string,
    docId: string,
    ops: IOtOperation[]
  ) {
    const dbTableName = await this.recordService.getDbTableName(prisma, collection);

    const ops2Contexts = OpBuilder.ops2Contexts(ops);
    // group by op name execute faster
    const ops2ContextsGrouped = groupBy(ops2Contexts, 'name');
    for (const opName in ops2ContextsGrouped) {
      const opContexts = ops2ContextsGrouped[opName];
      switch (opName) {
        case OpName.SetRecordOrder:
          await this.setRecordOrder(
            prisma,
            version,
            docId,
            dbTableName,
            opContexts as ISetRecordOrderOpContext[]
          );
          break;
        case OpName.SetRecord:
          await this.setRecords(
            prisma,
            version,
            docId,
            dbTableName,
            opContexts as ISetRecordOpContext[]
          );
          break;
        case OpName.SetColumnMeta:
          await this.setColumnMeta(prisma, version, docId, opContexts as ISetColumnMetaOpContext[]);
          break;
        case OpName.AddColumnMeta:
          await this.addColumnMeta(prisma, version, docId, opContexts as IAddColumnMetaOpContext[]);
          break;
        case OpName.SetFieldName:
          await this.setFieldName(prisma, version, docId, opContexts as ISetFieldNameOpContext[]);
          break;
        default:
          throw new Error(`op name ${opName} save method did not implement`);
      }
    }
  }

  private async createSnapshot(
    prisma: Prisma.TransactionClient,
    collection: string,
    docId: string,
    snapshot: unknown
  ) {
    const docType = docId.slice(0, 3);
    switch (docType) {
      case IdPrefix.Table:
        await this.addTable(prisma, snapshot as ITableSnapshot);
        break;
      case IdPrefix.Record:
        await this.addRecord(prisma, collection, docId);
        break;
      case IdPrefix.Field:
        await this.addField(prisma, collection, snapshot as IFieldSnapshot);
        break;
      case IdPrefix.View:
        await this.addView(prisma, collection, snapshot as IViewSnapshot);
        break;
      default:
        break;
    }
  }

  // Persists an op and snapshot if it is for the next version. Calls back with
  // callback(err, succeeded)
  async commit(
    collection: string,
    id: string,
    rawOp: CreateOp | DeleteOp | EditOp,
    snapshot: ICollectionSnapshot,
    options: unknown,
    callback: (err: unknown, succeed?: boolean) => void
  ) {
    /*
     * op: CreateOp {
     *   src: '24545654654646',
     *   seq: 1,
     *   v: 0,
     *   create: { type: 'http://sharejs.org/types/JSONv0', data: { ... } },
     *   m: { ts: 12333456456 } }
     * }
     * snapshot: PostgresSnapshot
     */

    // console.log('commit', collection, id, rawOp, snapshot);

    try {
      const prisma = this.transactionService.get(collection);
      const opsResult = await prisma.ops.aggregate({
        _max: { version: true },
        where: { collection, docId: id },
      });

      const maxVersion = opsResult._max.version || 0;

      if (snapshot.v !== maxVersion + 1) {
        return callback(
          new Error(`version mismatch: maxVersion: ${maxVersion} snapshotV: ${snapshot.v}`)
        );
      }

      // 1. save op in db;
      await prisma.ops.create({
        data: {
          docId: id,
          collection,
          version: snapshot.v,
          operation: JSON.stringify(rawOp),
        },
      });

      // create snapshot
      if (rawOp.create) {
        await this.createSnapshot(prisma, collection, id, rawOp.create.data);
      }

      // update snapshot
      if (rawOp.op) {
        await this.updateSnapshot(prisma, snapshot.v, collection, id, rawOp.op);
      }

      callback(null, true);
    } catch (err) {
      callback(err);
    }
  }

  /**
   * get record snapshot from db
   * @param tableId
   * @param recordIds
   * @param projection projection for fieldIds
   * @returns snapshotData
   */
  private async getRecordSnapshotBulk(
    prisma: Prisma.TransactionClient,
    tableId: string,
    recordIds: string[],
    projection?: IProjection
  ): Promise<ISnapshotBase<IRecordSnapshot>[]> {
    return await this.recordService.getRecordSnapshotBulk(prisma, tableId, recordIds, projection);
  }

  private async getFieldSnapshotBulk(
    prisma: Prisma.TransactionClient,
    tableId: string,
    fieldIds: string[]
  ): Promise<ISnapshotBase<IFieldSnapshot>[]> {
    const fields = await prisma.field.findMany({
      where: { tableId, id: { in: fieldIds } },
    });
    const fieldInstances = fields.map((field) => createFieldInstanceByRaw(field));

    return fields
      .map((field, i) => {
        return {
          id: field.id,
          v: field.version,
          type: 'json0',
          data: {
            field: instanceToPlain(fieldInstances[i]) as FieldVo,
            columnMeta: JSON.parse(field.columnMeta),
          },
        };
      })
      .sort((a, b) => fieldIds.indexOf(a.id) - fieldIds.indexOf(b.id));
  }

  private async getViewSnapshotBulk(
    prisma: Prisma.TransactionClient,
    tableId: string,
    viewIds: string[]
  ): Promise<ISnapshotBase<IViewSnapshot>[]> {
    const views = await prisma.view.findMany({
      where: { tableId, id: { in: viewIds } },
    });

    return views
      .map((view) => {
        return {
          id: view.id,
          v: view.version,
          type: 'json0',
          data: {
            view: {
              ...view,
              type: view.type as ViewType,
              description: view.description || undefined,
              filter: JSON.parse(view.filter as string),
              sort: JSON.parse(view.sort as string),
              group: JSON.parse(view.group as string),
              options: JSON.parse(view.options as string),
            },
            order: view.order,
          },
        };
      })
      .sort((a, b) => viewIds.indexOf(a.id) - viewIds.indexOf(b.id));
  }

  private async getAggregateBulk(
    prisma: Prisma.TransactionClient,
    tableId: string,
    rowCountIds: string[]
  ): Promise<ISnapshotBase<number>[]> {
    const aggregateResults: number[] = [];
    for (const id of rowCountIds) {
      const [aggregateKey, viewId] = id.split('_');
      let result: number;
      switch (aggregateKey) {
        case AggregateKey.RowCount: {
          result = await this.recordService.getRowCount(prisma, tableId, viewId);
          break;
        }
        case AggregateKey.Average: {
          throw new Error(`aggregate ${aggregateKey} not implemented`);
        }
        default: {
          throw new Error(`aggregate ${aggregateKey} not implemented`);
        }
      }
      aggregateResults.push(result);
    }

    return aggregateResults.map((result, i) => {
      return { id: rowCountIds[i], v: 1, type: 'json0', data: result };
    });
  }

  // Get the named document from the database. The callback is called with (err,
  // snapshot). A snapshot with a version of zero is returned if the document
  // has never been created in the database.
  async getSnapshotBulk(
    collection: string,
    ids: string[],
    projection: IProjection | undefined,
    options: unknown,
    callback: (err: ShareDb.Error | null, data?: Snapshot[]) => void
  ) {
    try {
      const prisma = this.transactionService.get(collection);
      const docType = ids[0].slice(0, 3);
      if (ids.find((id) => id.slice(0, 3) !== docType)) {
        throw new Error('get snapshot bulk ids must be same type');
      }

      let snapshotData: ISnapshotBase[] = [];
      switch (docType) {
        case IdPrefix.Record:
          snapshotData = await this.getRecordSnapshotBulk(
            prisma,
            collection,
            ids,
            // Do not project when called by ShareDB submit
            projection && projection['$submit'] ? undefined : projection
          );
          break;
        case IdPrefix.Field:
          snapshotData = await this.getFieldSnapshotBulk(prisma, collection, ids);
          break;
        case IdPrefix.View:
          snapshotData = await this.getViewSnapshotBulk(prisma, collection, ids);
          break;
        case IdPrefix.Aggregate: {
          snapshotData = await this.getAggregateBulk(prisma, collection, ids);
          break;
        }
        default:
          break;
      }

      if (snapshotData.length) {
        const snapshots = snapshotData.map(
          (snapshot) =>
            new Snapshot(
              snapshot.id,
              snapshot.v,
              snapshot.type,
              snapshot.data,
              null // TODO: metadata
            )
        );
        callback(null, snapshots);
      } else {
        const snapshots = ids.map((id) => new Snapshot(id, 0, null, undefined, null));
        callback(null, snapshots);
      }
    } catch (err) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      callback(err as any);
    }
  }

  async getSnapshot(
    collection: string,
    id: string,
    projection: IProjection | undefined,
    options: unknown,
    callback: (err: unknown, data?: Snapshot) => void
  ) {
    this.getSnapshotBulk(collection, [id], projection, options, (err, data) => {
      if (err) {
        callback(err);
      } else {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        callback(null, data![0]);
      }
    });
  }

  // Get operations between [from, to) non-inclusively. (Ie, the range should
  // contain start but not end).
  //
  // If end is null, this function should return all operations from start onwards.
  //
  // The operations that getOps returns don't need to have a version: field.
  // The version will be inferred from the parameters if it is missing.
  //
  // Callback should be called as callback(error, [list of ops]);
  async getOps(
    collection: string,
    id: string,
    from: number,
    to: number,
    options: unknown,
    callback: (error: unknown, data?: unknown) => void
  ) {
    try {
      const prisma = this.transactionService.get(collection);
      const res = await prisma.$queryRawUnsafe<
        { collection: string; id: string; from: number; to: number; operation: string }[]
      >(
        'SELECT version, operation FROM ops WHERE collection = ? AND doc_id = ? AND version >= ? AND version < ?',
        collection,
        id,
        from,
        to
      );

      callback(
        null,
        res.map(function (row) {
          return JSON.parse(row.operation);
        })
      );
    } catch (err) {
      callback(err);
    }
  }
}

class Snapshot implements ShareDb.Snapshot {
  constructor(
    public id: string,
    public v: number,
    public type: string | null,
    public data: unknown,
    public m: SnapshotMeta | null
  ) {}
}
