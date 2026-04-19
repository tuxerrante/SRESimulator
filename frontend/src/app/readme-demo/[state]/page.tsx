import type { ReactNode } from "react";
import {
  Shield,
  AlertTriangle,
  Terminal,
  LayoutDashboard,
  BookOpen,
  User,
  Bot,
  Activity,
  AlertCircle,
  Server,
  ArrowUpCircle,
  Trophy,
  Target,
  FileText,
  Crosshair,
} from "lucide-react";

type DemoState = "overview" | "dashboard" | "guide" | "chat" | "score";

const INCIDENT = {
  title: "Mock incident for easy difficulty",
  severity: "Sev4",
  id: "IcM-MOCK-EASY",
  description: "API pods are offline and the cluster reports a degraded state in mock mode.",
  impact: "No customer impact. This demo is a safe mock investigation session.",
  clusterName: "aro-easy-mock",
  region: "eastus",
};

const SCORE_BY_STATE: Record<DemoState, number> = {
  overview: 0,
  dashboard: 5,
  guide: 5,
  chat: 6,
  score: 6,
};

function normalizeState(value: string): DemoState {
  if (value === "dashboard" || value === "guide" || value === "chat" || value === "score") {
    return value;
  }
  return "overview";
}

export default async function ReadmeDemoPage({
  params,
}: {
  params: Promise<{ state: string }>;
}) {
  const { state: rawState } = await params;
  const state = normalizeState(rawState);
  const score = SCORE_BY_STATE[state];
  const activeTab = state === "dashboard" ? "dashboard" : state === "guide" ? "guide" : "terminal";

  return (
    <div className="h-screen overflow-hidden bg-zinc-950 text-zinc-100">
      <header className="flex items-center gap-4 border-b border-zinc-700 bg-zinc-900 px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex items-center gap-2">
            <Shield size={18} className="text-amber-500" />
            <span className="font-bold text-sm text-zinc-200">SRE Simulator</span>
          </div>
          <div className="h-5 w-px bg-zinc-700" />
          <span className="max-w-[22rem] truncate text-sm text-zinc-400">Mock EASY scenario</span>
          <span className="rounded px-1.5 py-0.5 text-xs font-medium bg-emerald-600/20 text-emerald-400">
            easy
          </span>
        </div>
        <div className="flex items-center gap-4">
          <div className="rounded bg-amber-600/20 px-2 py-0.5 text-xs font-medium text-amber-400 ring-1 ring-amber-600/50">
            Reading
          </div>
          <button className="flex items-center gap-1.5 rounded px-2 py-1 text-sm font-mono hover:bg-zinc-800 transition-colors">
            <span className="text-zinc-500">Score:</span>
            <span className="font-bold text-amber-400">{score}</span>
            <span className="text-zinc-600">/100</span>
          </button>
        </div>
      </header>

      <div className="grid h-[calc(100vh-49px)] grid-cols-[2fr_3fr] overflow-hidden">
        <div className="flex flex-col overflow-hidden border-r border-zinc-700 bg-zinc-900">
          <section className="border-b border-zinc-700 bg-zinc-800/50">
            <div className="grid gap-3 px-4 py-4">
              <div className="flex items-center gap-2">
                <span className="rounded bg-red-600/20 px-1.5 py-0.5 text-xs font-semibold text-red-400">
                  {INCIDENT.severity}
                </span>
                <span className="text-xs text-zinc-500">{INCIDENT.id}</span>
              </div>
              <div>
                <h2 className="text-sm font-semibold text-zinc-100">{INCIDENT.title}</h2>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400">{INCIDENT.description}</p>
              </div>
              <div className="grid grid-cols-2 gap-3 text-xs">
                <Meta label="Cluster" value={INCIDENT.clusterName} />
                <Meta label="Region" value={INCIDENT.region} />
                <Meta label="Customer Impact" value={INCIDENT.impact} className="col-span-2" />
              </div>
            </div>
          </section>

          <section className="flex min-h-0 flex-1 flex-col">
            <div className="border-b border-zinc-700 bg-zinc-800 px-4 py-2">
              <h2 className="text-sm font-semibold text-zinc-200">Investigation Chat</h2>
            </div>
            <div className="flex-1 overflow-hidden">
              {state === "overview" || state === "dashboard" || state === "guide" ? (
                <div className="flex h-full items-center justify-center px-8 text-center text-sm text-zinc-600">
                  Start your investigation by describing what you observe in the incident ticket.
                </div>
              ) : (
                <div className="flex h-full flex-col overflow-hidden">
                  <ChatBubble
                    role="user"
                    title="You"
                    color="bg-blue-600"
                    content="I see API pods offline and a degraded cluster. What should I check first?"
                  />
                  <ChatBubble
                    role="assistant"
                    title="Dungeon Master"
                    color="bg-amber-600"
                    content="Begin with context gathering. Check the cluster dashboard, then inspect recent events before taking action."
                  />
                  <div className="mt-auto border-t border-zinc-700 bg-zinc-900 p-3">
                    <div className="flex items-end gap-2">
                      <div className="min-h-11 flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-400">
                        Describe what you want to investigate...
                      </div>
                      <div className="rounded-lg bg-amber-600 p-2 text-white">Send</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        <div className="flex min-h-0 flex-col overflow-hidden bg-zinc-950">
          <div className="flex border-b border-zinc-700 bg-zinc-900">
            <Tab active={activeTab === "terminal"} icon={<Terminal size={14} />} label="Terminal" activeClass="border-emerald-500 text-emerald-400" />
            <Tab active={activeTab === "dashboard"} icon={<LayoutDashboard size={14} />} label="Dashboard" activeClass="border-blue-500 text-blue-400" />
            <Tab active={activeTab === "guide"} icon={<BookOpen size={14} />} label="Guide" activeClass="border-purple-500 text-purple-400" />
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            {state === "dashboard" ? <DashboardSnapshot /> : null}
            {state === "guide" ? <GuideSnapshot /> : null}
            {state === "overview" ? <TerminalEmpty /> : null}
            {(state === "chat" || state === "score") ? <TerminalSnapshot /> : null}
          </div>
        </div>
      </div>

      {state === "score" ? <ScoreOverlay /> : null}
    </div>
  );
}

function Meta({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 ${className}`}>
      <div className="text-[10px] uppercase text-zinc-600">{label}</div>
      <div className="mt-1 text-xs leading-relaxed text-zinc-300">{value}</div>
    </div>
  );
}

function ChatBubble({
  title,
  color,
  content,
  role,
}: {
  title: string;
  color: string;
  content: string;
  role: "user" | "assistant";
}) {
  const Icon = role === "user" ? User : Bot;
  return (
    <div className={`flex gap-3 px-4 py-3 ${role === "user" ? "bg-zinc-800/50" : "bg-transparent"}`}>
      <div className={`mt-0.5 flex h-7 w-7 items-center justify-center rounded-full ${color}`}>
        <Icon size={14} className="text-white" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-1 text-xs text-zinc-500">{title}</div>
        <div className="max-w-none text-sm leading-relaxed text-zinc-200">{content}</div>
      </div>
    </div>
  );
}

function Tab({
  active,
  icon,
  label,
  activeClass,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  activeClass: string;
}) {
  return (
    <div
      className={`flex items-center gap-1.5 border-b-2 px-4 py-2 text-xs font-medium ${
        active ? activeClass : "border-transparent text-zinc-500"
      }`}
    >
      {icon}
      {label}
    </div>
  );
}

function TerminalEmpty() {
  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-700 bg-zinc-900 px-4 py-2">
        <Terminal size={14} className="text-emerald-400" />
        <h2 className="text-sm font-semibold text-zinc-200">Terminal</h2>
        <span className="ml-auto text-xs text-zinc-500">0 commands</span>
      </div>
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-zinc-700">
        <Terminal size={32} />
        <span>Command output will appear here</span>
        <span className="text-xs">Click &quot;Run&quot; on commands in the chat panel</span>
      </div>
    </div>
  );
}

function TerminalSnapshot() {
  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-700 bg-zinc-900 px-4 py-2">
        <Terminal size={14} className="text-emerald-400" />
        <h2 className="text-sm font-semibold text-zinc-200">Terminal</h2>
        <span className="ml-auto text-xs text-zinc-500">1 command</span>
      </div>
      <div className="flex-1 overflow-hidden p-4">
        <div className="overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900">
          <div className="flex items-center justify-between border-b border-zinc-700 bg-zinc-800 px-3 py-1.5">
            <span className="text-xs font-mono text-zinc-400">OpenShift CLI</span>
            <span className="rounded bg-zinc-700/30 px-2 py-0.5 text-xs text-zinc-500">Ran</span>
          </div>
          <pre className="overflow-hidden p-3 text-sm text-emerald-400">
            <code>{`$ oc get events --sort-by='.lastTimestamp'

LAST SEEN   TYPE      REASON     OBJECT               MESSAGE
2m          Warning   Unhealthy  pod/api-server-xyz   readiness probe failed
5m          Normal    Scheduled  pod/monitor-abc12    successfully assigned`}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

function DashboardSnapshot() {
  return (
    <div className="h-full space-y-4 overflow-y-auto bg-zinc-950 p-4">
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-zinc-500">
          <Server size={12} />
          Cluster Overview
        </h3>
        <div className="grid grid-cols-2 gap-2">
          <Card label="Name" value="aro-easy-mock" />
          <Card label="Version" value="4.19.9" />
          <Card label="Region" value="eastus" />
          <Card label="Nodes" value="6" />
          <Card label="Status" value="Degraded (mock)" className="col-span-2" valueClass="text-red-400" />
        </div>
      </section>
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-zinc-500">
          <AlertCircle size={12} />
          Active Alerts (1)
        </h3>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="mt-0.5 text-amber-400" />
            <div>
              <div className="text-xs font-medium text-amber-400">MockProbeFailure</div>
              <div className="mt-0.5 text-xs text-zinc-500">
                Mock AI mode alert to validate UI and command path.
              </div>
              <div className="mt-0.5 text-[10px] text-zinc-600">Firing since 25 minutes ago</div>
            </div>
          </div>
        </div>
      </section>
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-zinc-500">
          <Activity size={12} />
          Recent Events
        </h3>
        <div className="space-y-1">
          <EventLine color="text-zinc-400">16:10Z - monitor: mock alert triggered</EventLine>
          <EventLine color="text-amber-400">16:15Z - kubelet: probe timeout observed</EventLine>
        </div>
      </section>
      <section>
        <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase text-zinc-500">
          <ArrowUpCircle size={12} />
          Upgrade History
        </h3>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="font-mono text-zinc-400">4.19.8</span>
            <span className="text-zinc-600">&rarr;</span>
            <span className="font-mono text-zinc-300">4.19.9</span>
            <span className="ml-auto rounded bg-emerald-600/20 px-1.5 py-0.5 font-medium text-emerald-400">
              completed
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

function Card({
  label,
  value,
  className = "",
  valueClass = "",
}: {
  label: string;
  value: string;
  className?: string;
  valueClass?: string;
}) {
  return (
    <div className={`rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 ${className}`}>
      <div className="text-[10px] uppercase text-zinc-600">{label}</div>
      <div className={`text-sm font-mono text-zinc-300 ${valueClass}`}>{value}</div>
    </div>
  );
}

function EventLine({
  children,
  color,
}: {
  children: ReactNode;
  color: string;
}) {
  return <div className={`rounded border border-zinc-800 bg-zinc-900 px-3 py-1.5 text-xs ${color}`}>{children}</div>;
}

function GuideSnapshot() {
  return (
    <div className="flex h-full flex-col bg-zinc-950">
      <div className="flex items-center gap-2 border-b border-zinc-700 bg-zinc-900 px-4 py-2">
        <BookOpen size={14} className="text-purple-400" />
        <h2 className="text-sm font-semibold text-zinc-200">SRE Investigation Guide</h2>
      </div>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="mb-2 text-xs text-zinc-400">
            Work the investigation in order: Reading, Context, Facts, Theory, then Action.
          </div>
          <div className="space-y-1">
            <PhaseLine current icon={<FileText size={12} />} label="Reading" />
            <PhaseLine icon={<Activity size={12} />} label="Context Gathering" />
            <PhaseLine icon={<Target size={12} />} label="Facts Gathering" />
            <PhaseLine icon={<Crosshair size={12} />} label="Theory Building" />
            <PhaseLine icon={<Shield size={12} />} label="Action" />
          </div>
        </div>
        <div className="rounded-lg border border-blue-500/25 bg-blue-500/10 p-3">
          <div className="mb-1 text-sm font-semibold text-zinc-100">1. Reading</div>
          <p className="text-xs leading-relaxed text-zinc-300">
            Read the incident carefully and identify the concrete symptoms before touching the cluster.
          </p>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 opacity-70">
          <div className="mb-1 text-sm font-semibold text-zinc-300">2. Context Gathering</div>
          <p className="text-xs leading-relaxed text-zinc-500">
            Review dashboards, alerts, and recent events to build context before you run commands.
          </p>
        </div>
      </div>
    </div>
  );
}

function PhaseLine({
  icon,
  label,
  current = false,
}: {
  icon: ReactNode;
  label: string;
  current?: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2.5 rounded-md px-2.5 py-1.5 ${
        current ? "bg-blue-500/10 ring-1 ring-blue-500/25" : "text-zinc-500"
      }`}
    >
      <span className={`inline-flex h-5 w-5 items-center justify-center rounded text-[10px] font-bold ${current ? "text-blue-400" : "text-zinc-600"}`}>
        {current ? "1" : ""}
      </span>
      {icon}
      <span className={`text-xs font-medium ${current ? "text-blue-400" : "text-zinc-500"}`}>{label}</span>
      {current ? <span className="ml-auto h-1.5 w-1.5 rounded-full bg-blue-400" /> : null}
    </div>
  );
}

function ScoreOverlay() {
  return (
    <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/70 p-4">
      <div className="w-full max-w-lg rounded-xl border border-zinc-700 bg-zinc-900 shadow-2xl">
        <div className="flex items-center gap-2 border-b border-zinc-700 px-5 py-4">
          <Trophy size={20} className="text-amber-500" />
          <h2 className="font-bold text-zinc-200">Investigation Complete</h2>
        </div>
        <div className="px-5 py-4">
          <div className="mb-4 text-sm text-zinc-400">
            Scenario: <span className="text-zinc-200">Mock EASY scenario</span>
          </div>
          <div className="mb-6 flex items-center justify-center gap-4">
            <div className="text-6xl font-bold text-red-400">F</div>
            <div>
              <div className="text-2xl font-bold text-zinc-200">6/100</div>
              <div className="text-xs text-zinc-500">1 command executed</div>
            </div>
          </div>
          <div className="space-y-4">
            <ScoreRow icon={<Target size={14} className="text-blue-400" />} label="Efficiency" value={1} />
            <ScoreRow icon={<Shield size={14} className="text-emerald-400" />} label="Safety" value={5} />
            <ScoreRow icon={<FileText size={14} className="text-purple-400" />} label="Documentation" value={0} />
            <ScoreRow icon={<Crosshair size={14} className="text-amber-400" />} label="Accuracy" value={0} />
          </div>
          <div className="mt-6">
            <h3 className="mb-2 text-xs font-semibold uppercase text-zinc-500">Scoring Events</h3>
            <div className="space-y-1 text-xs">
              <div className="flex items-center gap-2">
                <span className="font-mono text-emerald-400">+5</span>
                <span className="text-zinc-500">safety</span>
                <span className="text-zinc-400">Checked dashboard before running commands</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-emerald-400">+1</span>
                <span className="text-zinc-500">efficiency</span>
                <span className="text-zinc-400">Validated mock AI chat path</span>
              </div>
            </div>
          </div>
          <div className="mt-6 flex gap-2">
            <div className="flex-1 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-500">
              Echo-7
            </div>
            <div className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-medium text-white">
              Submit to Leaderboard
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ScoreRow({
  icon,
  label,
  value,
}: {
  icon: ReactNode;
  label: string;
  value: number;
}) {
  const width = `${(value / 25) * 100}%`;
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        {icon}
        <span className="text-sm font-medium text-zinc-300">{label}</span>
        <span className="ml-auto text-sm font-mono text-zinc-400">{value}/25</span>
      </div>
      <div className="mb-1 h-2 overflow-hidden rounded-full bg-zinc-800">
        <div className={`h-full rounded-full ${value >= 5 ? "bg-emerald-500" : "bg-red-500"}`} style={{ width }} />
      </div>
    </div>
  );
}
