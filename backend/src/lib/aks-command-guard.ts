/**
 * Deterministic AKS safety net for real-AI chat responses.
 *
 * The OpenShift-heavy knowledge base sometimes leads the model to emit `oc`
 * guidance on AKS despite the kubectl-only system prompt. On AKS the frontend
 * blocks execution of `oc` blocks (they render as "not valid for AKS" with no
 * Run button), leaving the user with an unrunnable command. This helper rewrites
 * a slipped OpenShift command block into an equivalent, runnable `kubectl` block.
 *
 * Scope is intentionally narrow: only the fenced code-block language tag `oc`
 * and a single leading `oc ` command token inside such a block are rewritten.
 * Prose, other fence languages (kql, geneva, bash, ...), and the substring "oc"
 * inside other words are never touched. This function is pure and must ONLY be
 * applied when the active platform is AKS — never to ARO responses.
 */
export function enforceAksKubectl(text: string): string {
  // Match a fenced block whose info string is exactly `oc`:
  //   optional line lead + optional indent + ```[spaces]oc[spaces]\n + body + closing ```
  const OC_FENCE = /(^|\n)([ \t]*)```[ \t]*oc[ \t]*(\r?\n)([\s\S]*?)(\r?\n[ \t]*```)/g;
  return text.replace(
    OC_FENCE,
    (_match, lead: string, indent: string, openNl: string, body: string, closeFence: string) => {
      // Rewrite only a single leading `oc ` command token in the block body.
      const rewrittenBody = body.replace(/^([ \t]*)oc(\s)/, "$1kubectl$2");
      return `${lead}${indent}\`\`\`kubectl${openNl}${rewrittenBody}${closeFence}`;
    },
  );
}
