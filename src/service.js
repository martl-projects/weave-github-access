// GitHub access: gives a project's members access to the GitHub repositories whoever runs it handed that project in
// their GitHub keyvault, and takes it back when they leave. A repository can be handed to any number of projects: it
// gets everyone any of them lets in. Members get it with a GitHub account they proved and shared with the project
// (weave.account, checked by GitHub's verifier): read access to an organization's repository, write access to a
// person's (GitHub has no read-only collaborators there). It holds no GitHub access of its own: Weave hands it
// short-lived access from its person's keyvault (token), cut to what its contract declares and to that project's
// repositories. Weave only says who is in a project and whose accounts hold (readers, accounts), and knows nothing of
// GitHub. Each change it records in the project (github.added), to take back what it gave and nothing else.
import { accounts, answer, handed, load, log, me, publish, readers, save, tickEvery, token } from 'weave:service/host@0.1.0';

const API = 'https://api.github.com';
const isRepo = (value) => typeof value === 'string' && /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(value);

/**
 * Its projects, each with the repositories its person offers it (handed it, in their GitHub keyvault) and the
 * project took (its maintainers didn't decline them there).
 */
const projects = () => {
  const declined = state().declined ?? {};
  return JSON.parse(me()).spaces.map((s) => {
    let offered = [];
    try {
      offered = JSON.parse(handed('github', s.id)).filter(isRepo);
    } catch (error) {
      log(error?.message ?? String(error));
    }
    const no = new Set(declined[s.id] ?? []);
    return { id: s.id, name: s.name, offered, repos: offered.filter((r) => !no.has(r)) };
  });
};

/** Access to a repository for one of the projects it was handed to, from its person's keyvault. */
const tokenFor = (project, repo) => JSON.parse(token('github', project, [repo])).token;

/**
 * What it keeps (in its own folder): whom it gave access by repository (and in which project), and how each went. A
 * round may still wait for GitHub while another event comes: each change reads it afresh, changes only its own part
 * and keeps it at once (no await in between), so none undoes another's.
 */
const state = () => {
  const s = JSON.parse(load('state') ?? '{"gave":{},"status":{}}');
  // Invitations it's about to send (kept first, so a stop in between neither loses nor skips one).
  s.asking ??= {};
  // From before: whom it gave access, without where.
  for (const [repo, gave] of Object.entries(s.gave)) if (Array.isArray(gave)) s.gave[repo] = Object.fromEntries(gave.map((login) => [login, '']));
  return s;
};
const change = (edit) => {
  const s = state();
  edit(s);
  save('state', JSON.stringify(s));
};

/** A GitHub API call with a sign-in: its JSON (or nothing), or why not. */
async function github(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'weave-github-access', 'x-github-api-version': '2022-11-28', authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : method === 'POST' || method === 'PUT' ? { body: '{}' } : {}),
  });
  if (res.status === 401) throw new Error("GitHub doesn't take its access (any more): whoever runs it looks at their GitHub keyvault (Keys & devices)");
  if (!res.ok) throw new Error(`GitHub said ${res.status} for ${method} ${path}`);
  return res.status === 204 ? undefined : res.json().catch(() => undefined);
}

/** The members of a project with a GitHub account proven there: their logins (its person never: it's their repository). */
function wantedIn(project, person) {
  const members = new Set(JSON.parse(readers(project.id)));
  return JSON.parse(accounts(project.id, 'github'))
    .filter((a) => a.verified && members.has(a.did) && a.did !== person)
    .map((a) => ({ login: a.handle.toLowerCase(), project: project.id }));
}

/** Bring one repository in step with every project that chose it: invite whom any lets in, take back the rest it gave. */
async function syncRepo(repo, chosen, token) {
  const person = JSON.parse(me()).person;
  const want = new Map();
  for (const project of chosen) for (const w of wantedIn(project, person)) if (!want.has(w.login)) want.set(w.login, w);
  const known = state().status[repo];
  // A person's repository takes collaborators who write; an organization's, ones who only read.
  const personal = known?.personal ?? (await github(token, 'GET', `/repos/${repo}`)).owner?.type !== 'Organization';
  const gave = state().gave[repo] ?? {};
  const people = await github(token, 'GET', `/repos/${repo}/collaborators?affiliation=direct&per_page=100`);
  const invites = await github(token, 'GET', `/repos/${repo}/invitations?per_page=100`);
  const collaborators = new Set(people.map((p) => p.login.toLowerCase()));
  const invited = new Map(invites.filter((i) => i.invitee).map((i) => [i.invitee.login.toLowerCase(), i.id]));
  // Someone it invited who isn't in (or invited) any more declined or left on GitHub: not asked again.
  const asking = state().asking[repo] ?? {};
  const invite = [...want.values()].filter((w) => !collaborators.has(w.login) && !invited.has(w.login) && (!(w.login in gave) || asking[w.login]));
  const remove = Object.keys(gave).filter((l) => !want.has(l) && (collaborators.has(l) || invited.has(l)));
  const here = new Set(projects().map((p) => p.id));
  const given = (login, project) =>
    change((s) => {
      const now = (s.gave[repo] ??= {});
      if (project === undefined) delete now[login];
      else now[login] = project;
    });
  for (const w of invite) {
    // Kept before it's asked for, as still to ask: stopped in between (started again, say), it still knows to take
    // it back, and asks again rather than taking a missing invitation for a declined one.
    given(w.login, w.project);
    change((s) => void ((s.asking[repo] ??= {})[w.login] = true));
    try {
      await github(token, 'PUT', `/repos/${repo}/collaborators/${w.login}`, { permission: personal ? 'push' : 'pull' });
    } catch (error) {
      given(w.login, undefined);
      throw error;
    } finally {
      change((s) => {
        delete s.asking[repo]?.[w.login];
        if (!Object.keys(s.asking[repo] ?? {}).length) delete s.asking[repo];
      });
    }
    publish(w.project, 'github.added', JSON.stringify({ repo, login: w.login, on: true }));
  }
  for (const login of remove) {
    if (invited.has(login)) await github(token, 'DELETE', `/repos/${repo}/invitations/${invited.get(login)}`);
    else await github(token, 'DELETE', `/repos/${repo}/collaborators/${login}`);
    given(login, undefined);
    if (here.has(gave[login])) publish(gave[login], 'github.added', JSON.stringify({ repo, login, on: false }));
  }
  change((s) => {
    if (!Object.keys(s.gave[repo] ?? {}).length) delete s.gave[repo];
    s.status[repo] = { given: Object.keys(s.gave[repo] ?? {}).length, personal, time: new Date().toISOString() };
  });
}

/** Every repository handed to its projects, each with all of them; ones no project has any more only take back what it gave. */
async function syncAll() {
  const all = projects();
  const byRepo = new Map(Object.keys(state().gave).map((repo) => [repo, []]));
  for (const project of all) for (const repo of project.repos) byRepo.set(repo, [...(byRepo.get(repo) ?? []), project]);
  for (const [repo, chosen] of byRepo) {
    // Its access: through a project it's handed to; one taken back: through a project it gave access in (its keyvault
    // still mints it for a day, to take that back).
    const through = chosen[0]?.id ?? Object.values(state().gave[repo] ?? {}).find((p) => all.some((x) => x.id === p));
    if (!through) {
      log(`${repo}: in none of its projects any more, so it can't take back what it gave there`);
      continue;
    }
    try {
      await syncRepo(repo, chosen, tokenFor(through, repo));
    } catch (error) {
      change((s) => void (s.status[repo] = { ...(s.status[repo] ?? {}), problem: error?.message ?? String(error), time: new Date().toISOString() }));
    }
  }
}

/**
 * The access offers in a project, as a list Weave shows (its items): each repository offered, what members get there,
 * and for the one asking whether they have it (done), or that it's theirs. Declined ones too, to accept again.
 */
function offers(space, who) {
  const project = projects().find((p) => p.id === space);
  const s = state();
  const mine = JSON.parse(accounts(space, 'github')).find((a) => a.did === who && a.verified);
  const owner = who === JSON.parse(me()).person;
  return (project?.offered ?? []).map((repo) => {
    const st = s.status[repo] ?? {};
    const declined = !project.repos.includes(repo);
    const given = mine && mine.handle.toLowerCase() in (s.gave[repo] ?? {});
    const what = st.personal === undefined ? '' : st.personal ? 'write access' : 'read access';
    return {
      id: repo,
      title: repo,
      url: `https://github.com/${repo}`,
      detail: declined ? 'Declined in this project' : [what && `members get ${what}`, `${st.given ?? 0} given so far`, st.problem].filter(Boolean).join(' · '),
      ...(owner ? { done: 'Yours' } : given ? { done: '✓ You have access' } : mine && !declined ? { done: `Inviting ${mine.handle}…` } : {}),
      ...(declined ? { use: false, remove: false, more: [{ action: 'accept', label: 'Accept again' }] } : {}),
    };
  });
}

/** A project's maintainers decline an offer there (or accept it again): it gives nobody access there through it. */
function decline(space, repo, no) {
  if (!isRepo(repo)) throw new Error('which repository?');
  change((s) => {
    const all = new Set((s.declined ??= {})[space] ?? []);
    if (no) all.add(repo);
    else all.delete(repo);
    s.declined[space] = [...all];
    if (!s.declined[space].length) delete s.declined[space];
  });
}

export async function onEvent(text) {
  const item = JSON.parse(text);
  // Who's in changes without a word to it (someone leaves): checked every few minutes too. What its person hands a
  // project starts it again.
  if (item.kind === 'weave.start') tickEvery(5 * 60_000);
  if (['weave.start', 'weave.tick', 'weave.account'].includes(item.kind)) return syncAll();
  if (item.kind !== 'weave.service.request') return;
  const { action } = item.body ?? {};
  try {
    if (action === 'offers') return void answer(item.id, undefined, JSON.stringify(offers(item.space.id, item.author)), undefined);
    if (action === 'decline' || action === 'accept') {
      const repo = String(item.body?.data?.id ?? '');
      decline(item.space.id, repo, action === 'decline');
      answer(item.id, action === 'decline' ? `${repo} is declined here: nobody gets access through it in this project.` : `${repo} is accepted here again.`, undefined, undefined);
      // In step at once: access given through it here goes (or comes).
      return syncAll();
    }
    throw new Error('it answers offers, decline and accept');
  } catch (error) {
    answer(item.id, undefined, undefined, error?.message ?? String(error));
  }
}
