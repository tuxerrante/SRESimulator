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
 * and the leading `oc ` command token of every line inside such a block are
 * rewritten. Prose, other fence languages (kql, geneva, bash, ...), and the
 * substring "oc" inside other words are never touched. This function is pure and
 * must ONLY be applied when the active platform is AKS — never to ARO responses.
 */
export function enforceAksKubectl(text: string): string {
  // Match a fenced block whose info string is exactly `oc`:
  //   optional line lead + optional indent + ```[spaces]oc[spaces]\n + body + closing ```
  const OC_FENCE = /(^|\n)([ \t]*)```[ \t]*oc[ \t]*(\r?\n)([\s\S]*?)(\r?\n[ \t]*```)/g;
  return text.replace(
    OC_FENCE,
    (_match, lead: string, indent: string, openNl: string, body: string, closeFence: string) => {
      // A slipped `oc` block can hold multiple commands (one per line). Rewrite
      // the leading token of every line (`m` = per-line `^`, `g` = all lines)
      // so no `oc` invocation survives inside the runnable kubectl block.
      const rewrittenBody = body
        // `oc adm top nodes|pods` has no direct `kubectl adm` equivalent — the
        // kubectl form drops `adm` (`kubectl top nodes|pods`). Handle it before
        // the generic rewrite so the block stays runnable. Other `oc adm`
        // subcommands have no kubectl analogue and are left best-effort.
        .replace(/^([ \t]*)oc[ \t]+adm[ \t]+top(\s)/gm, "$1kubectl top$2")
        // Generic: leading `oc ` token → `kubectl `.
        .replace(/^([ \t]*)oc(\s)/gm, "$1kubectl$2");
      return `${lead}${indent}\`\`\`kubectl${openNl}${rewrittenBody}${closeFence}`;
    },
  );
}
