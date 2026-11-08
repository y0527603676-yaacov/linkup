import { redirect } from "next/navigation";
import { Shell } from "@/components/Shell";
import { getMyOrgs, pickOrg } from "@/lib/orgs";
import { ConnectForm } from "./ConnectForm";

type SP = Promise<Record<string, string | undefined>>;

export default async function Connect({ searchParams }: { searchParams: SP }) {
  const sp = await searchParams;
  const orgs = await getMyOrgs();
  const org = pickOrg(orgs.filter((o) => o.type === "store"), sp.org);
  if (!org) redirect("/app/new?type=store");
  return (
    <Shell org={org} orgs={orgs}>
      <div className="narrow">
        <h1>חיבור חנות WooCommerce</h1>
        <p className="muted">3 צעדים, בערך 5 דקות. אחרי החיבור LINKUP יוצרת קופונים לשותפים וסופרת מכירות אוטומטית.</p>
        <ConnectForm orgId={org.id} />
      </div>
    </Shell>
  );
}
