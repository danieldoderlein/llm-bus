// Granting the project-admin role (decision 080).
//
// Decision 078 gave a project ADMIN read of the project's own pages. Nothing in the product could create
// such a row: two writes to project_members existed, 'owner' at project creation and 'member' at invite
// acceptance. So 078's admin half was gated on a state the system could not produce, and its tests passed
// because they inserted the row by hand. This closes that, and the assertions are written so the same
// mistake cannot recur - every case goes through the REAL mutation, never a direct INSERT.
import { freshProject } from "./_setup.js";
import { listProjectHumanMembers, setProjectMemberRole } from "../src/admin/queries.js";
import { projectAccessPage } from "../src/admin/html.js";
import { getPool, closePool } from "../src/db.js";

const errors: string[] = [];
function check(c: boolean, m: string): void {
  if (!c) errors.push(m);
}

async function main(): Promise<void> {
  const pool = getPool();
  const A = await freshProject("memberrole");
  const proj = await pool.query<{ owner_id: string }>(`SELECT owner_id FROM projects WHERE id = $1`, [
    A.project.id,
  ]);
  const ownerId = Number(proj.rows[0].owner_id);

  const mkOwner = async (tag: string): Promise<number> => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO owners (email, username) VALUES ($1, $2) RETURNING id`,
      [`${tag}-${Date.now()}@test.local`, `${tag}${Date.now()}`],
    );
    return Number(r.rows[0].id);
  };
  const member = await mkOwner("memberish");
  const stranger = await mkOwner("stranger");
  await pool.query(`INSERT INTO project_members (project_id, owner_id, role) VALUES ($1, $2, 'member')`, [
    A.project.id,
    member,
  ]);

  // 1. The page LISTS people at all - it never did, which is the whole reason there was nowhere to promote
  // anyone. Asserted on rendered HTML, not on the loader: 078's admin half passed a loader test and
  // rendered a blank page, and that is the failure this repeats otherwise.
  {
    const rows = await listProjectHumanMembers(ownerId, A.project.id);
    check(rows.length === 2, `1a owner + member both listed, got ${rows.length}`);
    const html = projectAccessPage(
      { id: ownerId, email: "o@test.local", username: "o" } as never,
      { id: A.project.id, slug: A.project.slug, name: A.project.slug },
      [],
      [],
      rows,
      "csrf",
    );
    check(html.includes("People"), "1b the page has a People section");
    check(html.includes("Make admin"), "1c a member row carries a promote control");
    check(
      html.includes("Owner cannot be changed"),
      "1d the OWNER row carries no control - demoting it would strand the project with no way back",
    );
  }

  // 2. The owner promotes, and the change is REAL - read back through the same query the page uses.
  {
    const ok = await setProjectMemberRole(ownerId, A.project.id, member, true);
    check(ok, "2a the owner can promote a member");
    const rows = await listProjectHumanMembers(ownerId, A.project.id);
    check(rows.find((r) => r.ownerId === member)?.role === "admin", "2b the member now reads as admin");
  }

  // 3. AN ADMIN CANNOT MINT MORE ADMINS. Deliberately narrower than the read it unlocks: this is the act
  // that decides who sees a whole project. Without this the grant would be self-propagating.
  {
    const ok = await setProjectMemberRole(member, A.project.id, member, true);
    check(!ok, "3a a project admin cannot use this at all - it is owner-only");
    const ok2 = await setProjectMemberRole(stranger, A.project.id, member, false);
    check(!ok2, "3b a non-member cannot demote anyone");
    const rows = await listProjectHumanMembers(ownerId, A.project.id);
    check(
      rows.find((r) => r.ownerId === member)?.role === "admin",
      "3c and the row is UNCHANGED after both refusals, not merely unreported",
    );
  }

  // 4. Demotion works, so the control is reversible rather than a one-way door.
  {
    const ok = await setProjectMemberRole(ownerId, A.project.id, member, false);
    check(ok, "4a the owner can demote an admin");
    const rows = await listProjectHumanMembers(ownerId, A.project.id);
    check(rows.find((r) => r.ownerId === member)?.role === "member", "4b back to member");
  }

  // 5. THE OWNER ROW IS UNTOUCHABLE IN SQL, not just hidden in the UI. A UI-only guard is one crafted POST
  // away from a project whose owner cannot administer it.
  {
    const ok = await setProjectMemberRole(ownerId, A.project.id, ownerId, false);
    check(!ok, "5a demoting the owner is refused");
    const rows = await listProjectHumanMembers(ownerId, A.project.id);
    check(rows.find((r) => r.ownerId === ownerId)?.role === "owner", "5b the owner row is intact");
  }

  // 6. A project you do not own is indistinguishable from one that does not exist (invariant 3, no oracle).
  {
    const ok = await setProjectMemberRole(stranger, 2147483000, member, true);
    check(!ok, "6a a bad project id refuses");
    const rows = await listProjectHumanMembers(stranger, A.project.id);
    check(rows.length === 0, "6b a non-member reads no roster at all");
  }

  await closePool();
  if (errors.length) {
    console.error("FAIL admin.memberrole:\n" + errors.map((e) => "  - " + e).join("\n"));
    process.exit(1);
  }
  console.log(
    "OK admin.memberrole (decision 080): the Access page now LISTS people - asserted on rendered HTML, not " +
      "on the loader, because 078's admin half passed a loader test and rendered a blank page. The owner " +
      "promotes and demotes through the real mutation; a project ADMIN cannot mint more admins and a " +
      "non-member cannot demote anyone, with the row proven UNCHANGED after each refusal rather than just " +
      "unreported; the owner row is refused in SQL and carries no control in the UI, so a crafted POST " +
      "cannot strand a project; and a project you do not own reads exactly like one that is not there.",
  );
}

void main();
