import { ChevronDown, ChevronUp, History, Link, MoreHorizontal, Trash2, X } from '@teable/icons';
import {
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Separator,
} from '@teable/ui-lib';
import { useMeasure } from 'react-use';
import { useTranslation } from '../../context/app/i18n';
import { usePermissionActionsStatic, useTablePermission } from '../../hooks';
import { TooltipWrap } from './TooltipWrap';

interface IExpandRecordHeader {
  title?: string;
  recordHistoryVisible?: boolean;
  disabledPrev?: boolean;
  disabledNext?: boolean;
  onClose?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  onCopyUrl?: () => void;
  onRecordHistoryToggle?: () => void;
  onDelete?: () => Promise<void>;
}

// eslint-disable-next-line @typescript-eslint/naming-convention
const MIN_TITLE_WIDTH = 300;
// eslint-disable-next-line @typescript-eslint/naming-convention
const MIN_OPERATOR_WIDTH = 200;

export const ExpandRecordHeader = (props: IExpandRecordHeader) => {
  const {
    title,
    recordHistoryVisible,
    disabledPrev,
    disabledNext,
    onPrev,
    onNext,
    onClose,
    onCopyUrl,
    onRecordHistoryToggle,
    onDelete,
  } = props;

  const { actionStaticMap } = usePermissionActionsStatic();
  const permission = useTablePermission();
  const editable = Boolean(permission['record|update']);
  const canDelete = Boolean(permission['record|delete']);
  const [ref, { width }] = useMeasure<HTMLDivElement>();
  const { t } = useTranslation();
  const showTitle = width > MIN_TITLE_WIDTH;
  const showOperator = width > MIN_OPERATOR_WIDTH;

  return (
    <div
      ref={ref}
      className={cn(
        'w-full h-12 flex items-center gap-4 px-4 border-b border-solid border-border',
        'justify-between' && !showTitle
      )}
    >
      <div>
        <TooltipWrap description="Previous record" disabled={disabledPrev}>
          <Button
            variant={'ghost'}
            tabIndex={-1}
            size={'xs'}
            onClick={onPrev}
            disabled={disabledPrev}
          >
            <ChevronUp />
          </Button>
        </TooltipWrap>
        <TooltipWrap description="Next record" disabled={disabledNext}>
          <Button
            variant={'ghost'}
            size={'xs'}
            tabIndex={-1}
            onClick={onNext}
            disabled={disabledNext}
          >
            <ChevronDown />
          </Button>
        </TooltipWrap>
      </div>
      {showTitle && (
        <h4
          title={title}
          className="flex-1 scroll-m-20 truncate text-xl font-semibold tracking-tight"
        >
          {title || t('common.unnamedRecord')}
        </h4>
      )}
      {showOperator && (
        <div className="flex items-center">
          <TooltipWrap description={t('expandRecord.copyRecordUrl')}>
            <Button variant={'ghost'} size={'xs'} onClick={onCopyUrl}>
              <Link />
            </Button>
          </TooltipWrap>
          {editable && (
            <TooltipWrap
              description={
                recordHistoryVisible
                  ? t('expandRecord.recordHistory.hiddenRecordHistory')
                  : t('expandRecord.recordHistory.showRecordHistory')
              }
            >
              <Button
                variant={recordHistoryVisible ? 'secondary' : 'ghost'}
                size={'xs'}
                onClick={onRecordHistoryToggle}
              >
                <History />
              </Button>
            </TooltipWrap>
          )}

          {canDelete ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="px-2">
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem
                  className="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm text-red-500 outline-none hover:text-red-500 focus:text-red-500 aria-selected:text-red-500"
                  onClick={async () => {
                    await onDelete?.();
                    onClose?.();
                  }}
                >
                  <Trash2 /> {t('expandRecord.deleteRecord')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      )}
      <Separator className="h-6" orientation="vertical" />
      <Button variant={'ghost'} size={'xs'} onClick={onClose}>
        <X />
      </Button>
    </div>
  );
};
