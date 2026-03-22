import Link from "next/link";
import { ArrowLeft, Github } from "lucide-react";

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <div className="flex-1 flex flex-col items-center px-6 py-12">
        <div className="w-full max-w-xl">
          <div className="flex items-center gap-3 mb-8">
            <Link
              href="/"
              className="text-zinc-500 hover:text-zinc-300 transition-colors"
            >
              <ArrowLeft size={20} />
            </Link>
            <h1 className="text-2xl font-bold tracking-tight">About</h1>
          </div>

          <div className="space-y-6 text-zinc-400 text-sm leading-relaxed">
            <p>
              <span className="text-zinc-200 font-semibold">SRE Simulator</span>{" "}
              is a break-fix training game for Azure Red Hat OpenShift. An AI
              Dungeon Master breaks your cluster in creative ways, then judges
              your investigation skills while you frantically type{" "}
              <code className="text-amber-400 bg-zinc-900 px-1 rounded">oc get nodes</code>{" "}
              and pretend you know what you&apos;re doing.
            </p>

            <p>
              Built by someone who has spent too many on-call nights staring at
              dashboards, fueled by coffee and the occasional existential
              question: &ldquo;Is the cluster down, or is it just me?&rdquo;
            </p>

            <p>
              If you find this useful, broken, or hilariously wrong &mdash;
              contributions, issues, and memes are all welcome.
            </p>

            <a
              href="https://github.com/tuxerrante"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 text-zinc-300 hover:text-amber-400 transition-colors"
            >
              <Github size={18} />
              github.com/tuxerrante
            </a>
          </div>
        </div>
      </div>

      <footer className="text-center text-zinc-700 text-xs py-4">
        ARO SRE Simulator &mdash; Investigation training powered by AI
      </footer>
    </div>
  );
}
