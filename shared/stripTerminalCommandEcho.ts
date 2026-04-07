/**
 * Normalize a command line for comparison with echoed terminal lines.
 */
function normalizeCommandLine(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/**
 * Remove leading lines that duplicate the shell command (models often echo
 * `[oc]`, `$ oc …`, or the bare command even though the UI already shows it).
 */
export function stripTerminalCommandEcho(output: string, command: string): string {
  const cmdNorm = normalizeCommandLine(command);
  if (cmdNorm === "") {
    return output;
  }

  const lines = output.replace(/^\uFEFF/, "").split(/\r?\n/);
  let strippedEcho = false;

  while (lines.length > 0) {
    const line = lines[0].trim();

    if (line === "") {
      if (strippedEcho) {
        lines.shift();
        continue;
      }
      break;
    }

    if (/^\[(oc|kql|geneva)\]$/i.test(line)) {
      lines.shift();
      strippedEcho = true;
      continue;
    }

    const dollar = line.match(/^\$\s*(.+)$/);
    if (dollar && normalizeCommandLine(dollar[1]) === cmdNorm) {
      lines.shift();
      strippedEcho = true;
      continue;
    }

    if (normalizeCommandLine(line) === cmdNorm) {
      lines.shift();
      strippedEcho = true;
      continue;
    }

    break;
  }

  if (strippedEcho) {
    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }
  }

  return lines.join("\n");
}
