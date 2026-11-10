export type PendingDoc = { doc_key: string; version: number; title_he: string | null; title_en: string | null; reacceptance: boolean };

/** Unchecked, required checkboxes for each pending legal document (rendered only when documents are published). */
export function LegalChecks({ docs, locale, lead }: { docs: PendingDoc[]; locale: string; lead: string }) {
  if (!docs.length) return null;
  return (
    <fieldset className="stack small" style={{ border: 0, padding: 0, margin: 0 }}>
      <legend className="muted">{lead}</legend>
      {docs.map((d) => {
        const title = (locale === "he" ? d.title_he ?? d.title_en : d.title_en ?? d.title_he) ?? d.doc_key;
        return (
          <label key={d.doc_key} className="row" style={{ alignItems: "flex-start", gap: 8 }}>
            <input type="checkbox" name="legal" value={d.doc_key} required style={{ width: "auto", marginTop: 4 }} />
            <span><a href={`/legal/${d.doc_key}`} target="_blank" rel="noopener">{title}</a></span>
            <input type="hidden" name="required" value={d.doc_key} />
          </label>
        );
      })}
    </fieldset>
  );
}
