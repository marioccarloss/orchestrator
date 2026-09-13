function normalize(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function escape(character: string): string {
  return /[.+^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
}

export function ruleGlobRegExp(pattern: string): RegExp {
  const source = normalize(pattern);
  let output = "^";
  for (let index = 0; index < source.length;) {
    const character = source[index] ?? "";
    if (source.startsWith("**/", index)) {
      output += "(?:[^/]+/)*";
      index += 3;
    } else if (source.startsWith("**", index)) {
      output += ".*";
      index += 2;
    } else if (character === "*") {
      output += "[^/]*";
      index += 1;
    } else if (character === "?") {
      output += "[^/]";
      index += 1;
    } else {
      output += escape(character);
      index += 1;
    }
  }
  return new RegExp(`${output}$`, "u");
}

export function matchesRulePath(path: string, patterns: readonly string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => ruleGlobRegExp(pattern).test(normalize(path)));
}
