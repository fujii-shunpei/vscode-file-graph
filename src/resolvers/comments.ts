/** How one language writes comments and string literals. */
export interface CommentSyntax {
  /** Sticky pattern for a comment running to the end of the line. */
  lineComment: RegExp;
  /** Opening and closing delimiter of a comment spanning lines, when the language has one. */
  blockComment?: readonly [open: string, close: string];
  /** Characters that open and close a string literal. */
  quotes: string[];
}

export const TS_COMMENT_SYNTAX: CommentSyntax = {
  lineComment: /\/\//y,
  blockComment: ["/*", "*/"],
  quotes: ["'", '"', "`"],
};

export const PHP_COMMENT_SYNTAX: CommentSyntax = {
  // `#[` opens a PHP 8 attribute rather than a comment, and attributes carry
  // `::class` references that are real dependencies.
  lineComment: /\/\/|#(?!\[)/y,
  blockComment: ["/*", "*/"],
  quotes: ["'", '"'],
};

export const PYTHON_COMMENT_SYNTAX: CommentSyntax = {
  // Only `#` comments are handled. Docstrings are left standing: telling one apart
  // from any other string expression needs a real parser, and a string is where an
  // import keeps its target, so a wrong guess would delete live dependencies. Their
  // inner lines are therefore read as code, and a `#` inside a docstring is blanked
  // like any other comment, which costs nothing because a docstring holds prose.
  lineComment: /#/y,
  quotes: ["'", '"'],
};

/** Replace every character except newlines, so line numbers survive. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/**
 * Index just past the end of the string literal opening at `start`.
 *
 * An unterminated literal ends at the newline: a stray quote (an apostrophe in JSX
 * text, a heredoc) then costs at most one line of comment stripping instead of
 * swallowing the rest of the file.
 */
function findStringEnd(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === quote) return i + 1;
    if (char === "\n") return i;
    i++;
  }
  return source.length;
}

/**
 * Blank out the comments in a source file, keeping every other character in place.
 *
 * Import patterns are regular expressions with no notion of context, so a comment
 * mentioning an import reads exactly like the real thing. Comments are replaced by
 * spaces rather than removed so that offsets and line numbers stay as they were and
 * line anchored patterns keep matching what they used to.
 *
 * String literals are skipped over untouched, both because an import keeps its target
 * inside one and because a `//` or `#` appearing in a string (a URL, a path) must not
 * be mistaken for the start of a comment. An import written inside a string is
 * therefore still reported.
 */
export function stripComments(source: string, syntax: CommentSyntax): string {
  let out = "";
  let copiedUpTo = 0;
  let i = 0;

  while (i < source.length) {
    if (syntax.quotes.includes(source[i])) {
      // Copied verbatim: leaving it pending is enough, nothing is blanked here.
      i = findStringEnd(source, i, source[i]);
      continue;
    }

    syntax.lineComment.lastIndex = i;
    if (syntax.lineComment.test(source)) {
      const newline = source.indexOf("\n", i);
      const end = newline === -1 ? source.length : newline;
      out += source.slice(copiedUpTo, i) + blank(source.slice(i, end));
      copiedUpTo = end;
      i = end;
      continue;
    }

    if (syntax.blockComment && source.startsWith(syntax.blockComment[0], i)) {
      const [open, close] = syntax.blockComment;
      const closeAt = source.indexOf(close, i + open.length);
      // An unclosed block comment runs to the end of the file, as a compiler sees it.
      const end = closeAt === -1 ? source.length : closeAt + close.length;
      out += source.slice(copiedUpTo, i) + blank(source.slice(i, end));
      copiedUpTo = end;
      i = end;
      continue;
    }

    i++;
  }

  return out + source.slice(copiedUpTo);
}
