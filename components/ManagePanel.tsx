"use client";

// Management panel: workflows (and their schedules), plugins (and their permissions), saved memories, knowledge collections (local RAG index)
// and research projects.
//
// It has NO private channel to the daemon and invents no state. REFRESH submits an ordinary request ("List my plugins.") through the same path as typing
// it; the table below is parsed from the reply that request actually got. Every button submits another ordinary request ("Grant the plugin X the
// files.read permission"), so the same local runtime, grounding, approval cards and Emergency Stop apply. Anything that deletes or removes asks for a second click.

import { useEffect, useMemo, useRef, useState } from "react";
import { REPORT_KINDS, REQ, RESEARCH_SCOPES, WEEKDAYS, collectionName, parseCollections, parseMemories, parsePlugins, parseResearch, parseWorkflows, scheduleWhen } from "@/lib/manage";

export interface ManageHistoryEntry { id: string; command: string; response: string }
type Tab = "workflows" | "plugins" | "memory" | "knowledge" | "research";
const LIST: Record<Tab, string> = { workflows: REQ.listWorkflows(), plugins: REQ.listPlugins(), memory: REQ.listMemories(), knowledge: REQ.listCollections(), research: REQ.listResearch() };
const TITLES: Record<Tab, string> = { workflows: "WORKFLOWS", plugins: "PLUGINS", memory: "MEMORY", knowledge: "KNOWLEDGE", research: "RESEARCH" };

/** The newest reply to a request: "pending" while the placeholder is still shown, "none" if it was never asked. */
function replyTo(history: readonly ManageHistoryEntry[], request: string): { state: "none" | "pending" | "done"; text: string } {
  const e = history.find((h) => h.command === request.toUpperCase());
  if (!e) return { state: "none", text: "" };
  return e.response.startsWith("⏳") ? { state: "pending", text: "" } : { state: "done", text: e.response };
}

export function ManagePanel({ history, busy, onRun, onClose }: {
  history: readonly ManageHistoryEntry[];
  /** True while any task runs (the HUD runs one task at a time). */
  busy: boolean;
  /** Submits an ordinary request through the normal command path. */
  onRun: (request: string) => void;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>("workflows");
  const [armed, setArmed] = useState<string | null>(null);        // the destructive request waiting for its second click
  const [scheduling, setScheduling] = useState<string | null>(null);
  const [kind, setKind] = useState<"daily" | (typeof WEEKDAYS)[number]>("daily");
  const [time, setTime] = useState("09:00");
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [collection, setCollection] = useState("documents");
  const [topic, setTopic] = useState("");
  const [reportKind, setReportKind] = useState<keyof typeof REPORT_KINDS>("literature review");
  const [scope, setScope] = useState<keyof typeof RESEARCH_SCOPES>("my research papers");
  const refreshAfter = useRef<Tab | null>(null);
  const wasBusy = useRef(busy);
  const armTimer = useRef<number | null>(null);

  const run = (request: string, after: Tab) => { setArmed(null); setLastAction(request); refreshAfter.current = after; onRun(request); };
  const refresh = (t: Tab) => { setLastAction(null); refreshAfter.current = null; onRun(LIST[t]); };
  const destructive = (request: string, label: string, after: Tab) => (
    <button type="button" className="manage-btn manage-danger" disabled={busy} data-armed={armed === request}
      onClick={() => {
        if (armed === request) { run(request, after); return; }
        setArmed(request);
        if (armTimer.current) window.clearTimeout(armTimer.current);
        armTimer.current = window.setTimeout(() => setArmed(null), 4000);
      }}>
      {armed === request ? "CONFIRM?" : label}
    </button>
  );
  const act = (request: string, label: string, after: Tab, title?: string) => (
    <button type="button" className="manage-btn" disabled={busy} title={title} onClick={() => run(request, after)}>{label}</button>
  );

  // When a task started by this panel ends, show the new state (the list is asked for again; nothing is assumed).
  useEffect(() => {
    if (wasBusy.current && !busy && refreshAfter.current) { const t = refreshAfter.current; refreshAfter.current = null; onRun(LIST[t]); }
    wasBusy.current = busy;
  }, [busy, onRun]);
  useEffect(() => () => { if (armTimer.current) window.clearTimeout(armTimer.current); }, []);

  const reply = replyTo(history, LIST[tab]);
  const workflows = useMemo(() => (tab === "workflows" && reply.state === "done" ? parseWorkflows(reply.text) : null), [tab, reply.state, reply.text]);
  const plugins = useMemo(() => (tab === "plugins" && reply.state === "done" ? parsePlugins(reply.text) : null), [tab, reply.state, reply.text]);
  const memories = useMemo(() => (tab === "memory" && reply.state === "done" ? parseMemories(reply.text) : null), [tab, reply.state, reply.text]);
  const collections = useMemo(() => (tab === "knowledge" && reply.state === "done" ? parseCollections(reply.text) : null), [tab, reply.state, reply.text]);
  const projects = useMemo(() => (tab === "research" && reply.state === "done" ? parseResearch(reply.text) : null), [tab, reply.state, reply.text]);
  const lastReply = lastAction ? replyTo(history, lastAction) : null;

  const indexForm = (
    <div className="manage-form" key="index-form">
      <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Folder, e.g. D:\Papers" aria-label="Folder to index (full path)" maxLength={260} />
      <input value={collection} onChange={(e) => setCollection(e.target.value)} placeholder="collection" aria-label="Collection name" maxLength={38} />
      <button type="button" className="manage-btn" disabled={busy || !/^[A-Za-z]:\\/.test(folder.trim()) || collectionName(collection) === null}
        title="Reads the folder (only inside the folders D-ASK may read) and indexes it on this computer. Your files are not changed."
        onClick={() => { const n = collectionName(collection); if (n) run(REQ.indexFolder(folder.trim(), n), "knowledge"); }}>INDEX FOLDER</button>
      {act(REQ.indexCodebase(), "INDEX CODEBASE", "knowledge")}
    </div>
  );
  const researchForm = (
    <div className="manage-form" key="research-form">
      <select value={reportKind} onChange={(e) => setReportKind(e.target.value as typeof reportKind)} aria-label="Report type">
        {(Object.keys(REPORT_KINDS) as (keyof typeof REPORT_KINDS)[]).map((k) => <option key={k} value={k}>{k}</option>)}
      </select>
      <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="topic, e.g. graph neural networks" aria-label="Research topic" maxLength={160} />
      <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)} aria-label="Sources">
        {(Object.keys(RESEARCH_SCOPES) as (keyof typeof RESEARCH_SCOPES)[]).map((k) => <option key={k} value={k}>from {k}</option>)}
      </select>
      <button type="button" className="manage-btn" disabled={busy || topic.trim().length < 3}
        title="Searches only your locally indexed documents; the report is saved under Documents\D-ASK\Research."
        onClick={() => run(REQ.startResearch(reportKind, topic, scope), "research")}>START RESEARCH</button>
    </div>
  );

  const body = () => {
    if (tab === "knowledge" || tab === "research") return [tab === "knowledge" ? indexForm : researchForm, <div key="list">{listBody()}</div>];
    return listBody();
  };
  const listBody = () => {
    if (reply.state === "none") return <p className="manage-empty">Not loaded yet. Press REFRESH to ask D-ASK for the current {TITLES[tab].toLowerCase()}.</p>;
    if (reply.state === "pending") return <p className="manage-empty">⏳ ASKING THE LOCAL AGENT…</p>;
    if (tab === "workflows") {
      if (workflows === null) return <p className="manage-empty">The reply could not be read as a workflow list:<br />{reply.text.slice(0, 300)}</p>;
      if (!workflows.length) return <p className="manage-empty">No workflows are saved. Create one by typing: Save a workflow called NAME: first step; then second step</p>;
      return workflows.map((w) => (
        <div className="manage-row" key={w.name}>
          <div className="manage-main"><strong>{w.name}</strong> <span>{w.steps} step(s)</span> <span>{w.schedule ? `runs ${w.schedule}` : "not scheduled"}</span>{w.last ? <span>last: {w.last}</span> : null}</div>
          <div className="manage-actions">
            {act(REQ.runWorkflow(w.name), "RUN", "workflows")}
            <button type="button" className="manage-btn" disabled={busy} onClick={() => setScheduling(scheduling === w.name ? null : w.name)}>{w.schedule ? "RESCHEDULE" : "SCHEDULE"}</button>
            {w.schedule ? act(REQ.unscheduleWorkflow(w.name), "UNSCHEDULE", "workflows") : null}
            {destructive(REQ.deleteWorkflow(w.name), "DELETE", "workflows")}
          </div>
          {scheduling === w.name ? (
            <div className="manage-form">
              <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)} aria-label="Repeat">
                <option value="daily">every day</option>
                {WEEKDAYS.map((d) => <option key={d} value={d}>every {d}</option>)}
              </select>
              <input value={time} onChange={(e) => setTime(e.target.value)} placeholder="HH:MM" maxLength={5} aria-label="Time (24 hour, HH:MM)" />
              <button type="button" className="manage-btn" disabled={busy || scheduleWhen(kind, time) === null}
                title="D-ASK shows an approval card with every step and the time; nothing is scheduled until you approve it."
                onClick={() => { const when = scheduleWhen(kind, time); if (when) { setScheduling(null); run(REQ.scheduleWorkflow(w.name, when), "workflows"); } }}>SET (ASKS FOR APPROVAL)</button>
            </div>
          ) : null}
        </div>
      ));
    }
    if (tab === "plugins") {
      if (plugins === null) return <p className="manage-empty">The reply could not be read as a plugin list:<br />{reply.text.slice(0, 300)}</p>;
      if (!plugins.length) return <p className="manage-empty">No plugins in D-ASK&apos;s plugins folder.</p>;
      return plugins.map((p) => (
        <div className="manage-row" key={p.id}>
          <div className="manage-main">
            <strong>{p.id}</strong> <span>{p.version ?? ""}</span>
            <span className="manage-tag" data-state={!p.installed ? "off" : p.changed ? "bad" : p.enabled ? "ok" : "off"}>
              {!p.installed ? "NOT INSTALLED" : p.changed ? "CHANGED · DISABLED" : p.enabled ? "ENABLED" : "DISABLED"}
            </span>
            {p.tools.length ? <span>tools: {p.tools.join(", ")}</span> : null}{p.note ? <span>({p.note})</span> : null}
          </div>
          {p.installed && p.permissions.length ? (
            <div className="manage-perms">
              {p.permissions.map((perm) => (
                <span className="manage-perm" key={perm.name} data-granted={perm.granted}>
                  {perm.name} · {perm.granted ? "GRANTED" : "NOT GRANTED"}
                  {perm.name === "compute" ? null
                    : perm.granted ? act(REQ.revokePermission(p.id, perm.name), "REVOKE", "plugins")
                      : act(REQ.grantPermission(p.id, perm.name), "GRANT", "plugins", "D-ASK shows an approval card; nothing is granted until you approve it.")}
                </span>
              ))}
            </div>
          ) : null}
          <div className="manage-actions">
            {!p.installed ? act(REQ.installPlugin(p.id), "INSTALL (ASKS FOR APPROVAL)", "plugins") : (
              <>
                {p.enabled ? act(REQ.disablePlugin(p.id), "DISABLE", "plugins") : (p.changed ? null : act(REQ.enablePlugin(p.id), "ENABLE", "plugins"))}
                {destructive(REQ.removePlugin(p.id), "REMOVE", "plugins")}
              </>
            )}
          </div>
        </div>
      ));
    }
    if (tab === "knowledge") {
      if (collections === null) return <p className="manage-empty">The reply could not be read as a collection list:<br />{reply.text.slice(0, 300)}</p>;
      if (!collections.length) return <p className="manage-empty">Nothing is indexed yet. Index a folder above, or the codebase.</p>;
      return collections.map((c) => (
        <div className="manage-row" key={c.name}>
          <div className="manage-main">
            <strong>{c.name}</strong> <span>[{c.kind}]</span> <span>{c.documents} document(s) · {c.passages} passage(s)</span>
            <span className="manage-tag" data-state={c.embedded === "all" ? "ok" : "off"}>{c.embedded === "all" ? "SEMANTIC + KEYWORD" : `EMBEDDED ${c.embedded}`}</span>
            {c.unreadable ? <span className="manage-tag" data-state="bad">{c.unreadable} UNREADABLE</span> : null}
            <span>last indexed {c.last}</span>{c.note ? <span>({c.note})</span> : null}
            {c.folders.length ? <span>folders: {c.folders.join("; ")}</span> : null}
          </div>
          <div className="manage-actions">
            {act(REQ.refreshCollection(c.name), "REFRESH INDEX", "knowledge", "Re-reads the folders; only new or changed files are processed, deleted files leave the index.")}
            {destructive(REQ.removeCollection(c.name), "REMOVE FROM INDEX", "knowledge")}
          </div>
        </div>
      ));
    }
    if (tab === "research") {
      if (projects === null) return <p className="manage-empty">The reply could not be read as a research list:<br />{reply.text.slice(0, 300)}</p>;
      if (!projects.length) return <p className="manage-empty">No research projects yet. Start one above.</p>;
      return projects.map((p) => (
        <div className="manage-row" key={p.id}>
          <div className="manage-main"><strong>{p.topic}</strong> <span>{p.type}</span> <span>{p.versions} version(s)</span> <span>{p.sources} source(s)</span> <span>last {p.last}</span></div>
          <div className="manage-actions">
            {act(REQ.showResearch(p.id), "SHOW", "research")}
            {act(REQ.resumeResearch(p.id), "UPDATE (NEW VERSION)", "research", "Runs the research again over the current index and saves a new version; earlier versions are kept.")}
          </div>
        </div>
      ));
    }
    if (memories === null) return <p className="manage-empty">The reply could not be read as a memory list:<br />{reply.text.slice(0, 300)}</p>;
    if (!memories.length) return <p className="manage-empty">Nothing is saved. Say: Remember that … (passwords, keys and card numbers are never stored).</p>;
    return memories.map((m) => (
      <div className="manage-row" key={m.id}>
        <div className="manage-main"><span className="manage-id">{m.id}</span> {m.text} <span>({m.kind})</span></div>
        <div className="manage-actions">{destructive(REQ.forgetMemory(m.id), "FORGET", "memory")}</div>
      </div>
    ));
  };

  return (
    <section className="manage-panel" aria-label="Manage workflows, plugins, memory, knowledge and research">
      <header className="manage-head">
        <div role="group" aria-label="Sections" className="manage-tabs">
          {(Object.keys(LIST) as Tab[]).map((t) => (
            <button key={t} type="button" aria-pressed={tab === t} data-active={tab === t} className="manage-tab"
              onClick={() => { setTab(t); setArmed(null); setScheduling(null); }}>{TITLES[t]}</button>
          ))}
        </div>
        <div className="manage-head-actions">
          <button type="button" className="manage-btn" disabled={busy} onClick={() => refresh(tab)}>REFRESH</button>
          <button type="button" className="manage-btn" onClick={onClose} aria-label="Close the management panel">CLOSE</button>
        </div>
      </header>
      <div className="manage-body">{body()}</div>
      {busy ? <p className="manage-foot">⏳ A TASK IS RUNNING: BUTTONS ARE PAUSED UNTIL IT ENDS.</p> : null}
      {lastAction && lastReply ? (
        <p className="manage-foot" aria-live="polite">
          {lastAction}: {lastReply.state === "pending" ? "⏳ working…" : lastReply.state === "done" ? lastReply.text.replace(/\s+/g, " ").slice(0, 240) : "submitted"}
        </p>
      ) : null}
    </section>
  );
}
