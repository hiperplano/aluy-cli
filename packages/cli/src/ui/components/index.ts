// EST-0948 — barrel dos componentes Ink da TUI (handoff §10). Composição de
// blocos, não markup avulso.
export { Header, HEADER_BANNER_MIN_ROWS } from './Header.js';
export type { HeaderProps } from './Header.js';
export {
  Wordmark,
  WORDMARK_MARK_BLOCK,
  WORDMARK_LUY_BLOCK,
  WORDMARK_MARK_ASCII,
  WORDMARK_LUY_ASCII,
  WORDMARK_ROWS,
  MIN_WORDMARK_COLS,
} from './Wordmark.js';
export type { WordmarkProps } from './Wordmark.js';
export { StatusBar } from './StatusBar.js';
export type { StatusBarProps } from './StatusBar.js';
export { Composer } from './Composer.js';
export type { ComposerProps } from './Composer.js';
export { QueuedInputs, PendingInjects, PendingAsks, queuedInputsLines, VISIBLE_QUEUED } from './QueuedInputs.js';
export type { QueuedInputsProps, PendingInjectsProps, PendingAsksProps } from './QueuedInputs.js';
export { YouBlock, AluyBlock } from './TurnBlock.js';
export type { YouBlockProps, AluyBlockProps } from './TurnBlock.js';
export { ToolLine } from './ToolLine.js';
export type { ToolLineProps } from './ToolLine.js';
export { AskDialog } from './AskDialog.js';
export type { AskDialogProps } from './AskDialog.js';
// EST-1110 · ADR-0114 — <QuestionDialog>: a UI da tool `perguntar` (single/multi/text + "Outro").
export { QuestionDialog, OTHER_INDEX } from './QuestionDialog.js';
export type { QuestionDialogProps } from './QuestionDialog.js';
export { BrokerError } from './BrokerError.js';
export type { BrokerErrorProps } from './BrokerError.js';
export { BudgetGate } from './BudgetGate.js';
export type { BudgetGateProps } from './BudgetGate.js';
export { StuckGate } from './StuckGate.js';
export type { StuckGateProps } from './StuckGate.js';
export { CycleCeilingGate } from './CycleCeilingGate.js';
export type { CycleCeilingGateProps } from './CycleCeilingGate.js';
export { LoginFlow } from './LoginFlow.js';
export type { LoginFlowProps } from './LoginFlow.js';
export { SlashMenu } from './SlashMenu.js';
export type { SlashMenuProps } from './SlashMenu.js';
export { CommandPalette } from './CommandPalette.js';
export type { CommandPaletteProps } from './CommandPalette.js';
export { FilePicker, elidePath } from './FilePicker.js';
export type { FilePickerProps } from './FilePicker.js';
export { ModelPicker } from './ModelPicker.js';
export type { ModelPickerProps } from './ModelPicker.js';
export { HistoryPicker } from './HistoryPicker.js';
export type { HistoryPickerProps } from './HistoryPicker.js';
export { RewindPicker } from './RewindPicker.js';
export type { RewindPickerProps } from './RewindPicker.js';
export { PermissionsPanel } from './PermissionsPanel.js';
export type { PermissionsPanelProps } from './PermissionsPanel.js';
export { ThemePicker } from './ThemePicker.js';
export type { ThemePickerProps } from './ThemePicker.js';
// EST-0989 (i18n) — seletor de idioma (/lang), espelha o <ThemePicker>.
export { LangPicker } from './LangPicker.js';
export type { LangPickerProps } from './LangPicker.js';
// EST-0962 (/provider) — seletor de provider do modo Custom, espelha o <ThemePicker>.
export { ProviderPicker } from './ProviderPicker.js';
export type { ProviderPickerProps } from './ProviderPicker.js';
export { AttachChips } from './AttachChips.js';
export type { AttachChipsProps, AttachChip } from './AttachChips.js';
export { Boot } from './Boot.js';
export type { BootProps } from './Boot.js';
export { Onboarding } from './Onboarding.js';
export type { OnboardingProps } from './Onboarding.js';
export { Working } from './Working.js';
export type { WorkingProps } from './Working.js';
export { Spinner } from './Spinner.js';
export type { SpinnerProps } from './Spinner.js';
// EST-0973 — indicador de PROGRESSO de ops longas (det+indet, degrada). Reutilizável;
// aplicado primeiro no `/compact`.
export {
  ProgressBar,
  progressRatio,
  progressPercent,
  renderBar,
  DEFAULT_BAR_WIDTH,
} from './ProgressBar.js';
export type { ProgressBarProps } from './ProgressBar.js';
export { AluyLoader, AluyBootLoader, legRole } from './AluyLoader.js';
export type { AluyLoaderProps } from './AluyLoader.js';
export { UnsafeBanner } from './UnsafeBanner.js';
export type { UnsafeBannerProps } from './UnsafeBanner.js';
export { ModeIndicator } from './ModeIndicator.js';
export type { ModeIndicatorProps } from './ModeIndicator.js';
export { FooterHints } from './FooterHints.js';
export type { FooterHintsProps, HintState } from './FooterHints.js';
export { NoteBlock } from './NoteBlock.js';
export type { NoteBlockProps } from './NoteBlock.js';
export { BangBlock } from './BangBlock.js';
export type { BangBlockProps } from './BangBlock.js';
export { SubAgents } from './SubAgents.js';
export type { SubAgentsProps, SubAgentChildView } from './SubAgents.js';
// EST-0970 — <Doctor>: checklist PROGRESSIVA do `/doctor` (ticks ao vivo: ⠋ → ✓/⚠/✗).
export { Doctor } from './Doctor.js';
export type { DoctorProps, DoctorCheckView } from './Doctor.js';
// EST-0982 · ADR-0063 — controle/observabilidade da árvore de fluxos + contabilidade.
export { FlowTreeView } from './FlowTreeView.js';
export type { FlowTreeViewProps } from './FlowTreeView.js';
// EST-0990 — <ActivityLog>: coluna do LOG no split CHAT|LOG (V2 agrupado por agente).
export { ActivityLog } from './ActivityLog.js';
export type { ActivityLogProps } from './ActivityLog.js';
export { TestRunBlock } from './TestRunBlock.js';
export type { TestRunBlockProps } from './TestRunBlock.js';
export { TurnFooter } from './TurnFooter.js';
export type { TurnFooterProps } from './TurnFooter.js';
export { QuotaFooter } from './QuotaFooter.js';
export type { QuotaFooterProps } from './QuotaFooter.js';
export { Divider } from './Divider.js';
export type { DividerProps } from './Divider.js';
