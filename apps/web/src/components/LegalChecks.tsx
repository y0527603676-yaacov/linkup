export type PendingDoc = { doc_key: string; version: number; audience?: string; title_he: string | null; title_en: string | null; reacceptance: boolean };

const titleOf = (d: PendingDoc, locale: string) => (locale === "he" ? d.title_he ?? d.title_en : d.title_en ?? d.title_he) ?? d.doc_key;

/**
 * One unchecked, required consent box (wording from the approved interface copy) with links to the exact documents.
 * Renders nothing while no document is published. The keys travel as hidden fields; the server records
 * acceptance only when the box was ticked (name="agree").
 */
export function LegalChecks({ docs, locale, label, name = "agree" }: { docs: PendingDoc[]; locale: string; label: string; name?: string }) {
  if (!docs.length) return null;
  return (
    <fieldset className="stack small" style={{ border: 0, padding: 0, margin: 0 }}>
      <ul className="small" style={{ margin: 0, paddingInlineStart: 18 }}>
        {docs.map((d) => (
          <li key={d.doc_key}><a href={`/legal/${d.doc_key}`} target="_blank" rel="noopener">{titleOf(d, locale)}</a>
            <input type="hidden" name="legal" value={d.doc_key} /></li>
        ))}
      </ul>
      <label className="row" style={{ alignItems: "flex-start", gap: 8 }}>
        <input type="checkbox" name={name} value="1" required style={{ width: "auto", marginTop: 4 }} />
        <span>{label}</span>
      </label>
    </fieldset>
  );
}
