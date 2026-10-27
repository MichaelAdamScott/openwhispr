import { useTranslation } from "react-i18next";
export function BarkModelNotice() {
  const { t } = useTranslation();
  return (
    <div className="space-y-1 rounded-md border border-border bg-surface-1 p-3 text-xs text-muted-foreground">
      <p>{t("transcription.bark.cleanHelp")}</p>
      <p>{t("transcription.bark.proUnavailable")}</p>
      <p>{t("transcription.bark.exportNotice")}</p>
    </div>
  );
}
