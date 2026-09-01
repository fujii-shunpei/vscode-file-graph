/** How one language writes comments and string literals. */
export interface CommentSyntax {
  /** Sticky pattern for a comment running to the end of the line. */
  lineComment: RegExp;
  /** Opening and closing delimiter of a comment spanning lines, when the language has one. */
  blockComment?: readonly [open: string, close: string];
  /** Characters that open and close a string literal a newline ends. */
  quotes: string[];
  /**
   * Characters that open and close a string literal a newline does not end, held
   * apart from `quotes` rather than listed in both.
   *
   * A literal that spans lines has to be skipped whole: read line by line, its second
   * line onwards is taken for code, and whatever it quotes - a comment opener, an
   * import - is then acted on as if it had been written in the file.
   */
  multilineQuotes?: string[];
}

export const TS_COMMENT_SYNTAX: CommentSyntax = {
  lineComment: /\/\//y,
  blockComment: ["/*", "*/"],
  quotes: ["'", '"'],
  multilineQuotes: ["`"],
};

export const PHP_COMMENT_SYNTAX: CommentSyntax = {
  // `#[` opens a PHP 8 attribute rather than a comment, and attributes carry
  // `::class` references that are real dependencies.
  lineComment: /\/\/|#(?!\[)/y,
  blockComment: ["/*", "*/"],
  // A heredoc body spans lines but `multilineQuotes` cannot hold it: its delimiter is
  // an identifier the file picks, not a character, so recognising one takes more than
  // a set membership test. Its body is read as code until then.
  quotes: ["'", '"'],
};

export const PYTHON_COMMENT_SYNTAX: CommentSyntax = {
  // Only `#` comments are handled. Docstrings are left standing: telling one apart
  // from any other string expression needs a real parser, and a string is where an
  // import keeps its target, so a wrong guess would delete live dependencies.
  //
  // A docstring is read as its three quotes would be read anywhere else: the first
  // two open and close an empty literal, and the third opens one running to the next
  // quote. Where the text lands therefore depends on where the docstring ends. One
  // spanning lines has that third literal end at the first newline, so its inner
  // lines are read as code and a `#` there is blanked like any other comment; a
  // single line one has its whole text read as that literal, so its `#` survives.
  // Either way nothing is lost, because a docstring holds prose.
  lineComment: /#/y,
  quotes: ["'", '"'],
};

/** Replace every character except newlines, so line numbers survive. */
function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/** Where a string literal ended, and whether anything ended it. */
interface StringEnd {
  /** Index just past the literal. */
  end: number;
  /** True when nothing closed the literal before the file ran out. */
  ranToEndOfFile: boolean;
}

/**
 * Where the string literal opening at `start` ends.
 *
 * With `endsAtNewline`, an unterminated literal ends at the newline: a stray quote -
 * an apostrophe in JSX text - then costs at most one line of comment stripping
 * instead of swallowing the rest of the file. That bound is why a newline is not
 * reported as a lost end, only the file running out is.
 */
function findStringEnd(
  source: string,
  start: number,
  quote: string,
  endsAtNewline: boolean
): StringEnd {
  let i = start + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      i += 2;
      continue;
    }
    if (char === quote) return { end: i + 1, ranToEndOfFile: false };
    if (endsAtNewline && char === "\n") return { end: i, ranToEndOfFile: false };
    i++;
  }
  return { end: source.length, ranToEndOfFile: true };
}

/** A delimiter opened in the source that nothing closed before the file ran out. */
export interface UnterminatedDelimiter {
  /** What was opened: a block comment swallows the rest of the file, a string quotes it. */
  kind: "block-comment" | "string";
  /** Index in the source where it was opened. */
  offset: number;
}

/** A source with its comments blanked, and the ends the scan never found. */
export interface StrippedSource {
  /** The source, comments replaced by spaces. */
  source: string;
  /** Delimiters left open, in the order they were opened. Empty for a file read whole. */
  unterminated: UnterminatedDelimiter[];
}

/**
 * Blank out the comments in a source file, keeping every other character in place.
 *
 * Import patterns are regular expressions with no notion of context, so a comment
 * mentioning an import reads exactly like the real thing. Comments are replaced by
 * spaces rather than removed so that offsets and line numbers stay as they were and
 * line anchored patterns keep matching what they used to.
 *
 * A literal written in `quotes` is skipped over untouched, both because an import
 * keeps its target inside one and because a `//` or `#` appearing in a string (a URL,
 * a path) must not be mistaken for the start of a comment. An import written inside
 * one is therefore still reported.
 *
 * A literal written in `multilineQuotes` is blanked instead. The asymmetry follows
 * from where a specifier can be written, not from a preference: every import pattern
 * spells its target between `'` or `"`, so blanking those would delete the
 * dependencies themselves, while no pattern can match inside a backtick and blanking
 * one loses nothing. What it gains is that the prose such a literal holds - a code
 * sample, a fixture, a template of a file to generate - stops reading as an import
 * of the project that quotes it.
 *
 * The cost accepted is that a `${...}` interpolation is code, and it is blanked with
 * the rest of the literal: a dynamic import written inside one is not seen. Scanning
 * interpolations as code is where to start if that ever matters.
 *
 * A delimiter left open runs to the end of the file and takes everything after it:
 * a block comment and a literal spanning lines blank the imports that follow, a
 * literal ended by a newline quotes what is left of its line. Either way the file was
 * only read as far as that delimiter, and an import blanked there is lost before
 * anything tries to resolve it, so it cannot even show up as an import that resolved
 * nowhere. `unterminated` is what says so; a compiler says it by refusing to compile
 * the file.
 */
export function stripComments(source: string, syntax: CommentSyntax): StrippedSource {
  const unterminated: UnterminatedDelimiter[] = [];
  let out = "";
  let copiedUpTo = 0;
  let i = 0;

  while (i < source.length) {
    if (syntax.multilineQuotes?.includes(source[i])) {
      // Blanked, unlike the literals below, because no import pattern can match
      // inside one: nothing is lost and the prose it holds stops reading as code.
      const literal = findStringEnd(source, i, source[i], false);
      if (literal.ranToEndOfFile) unterminated.push({ kind: "string", offset: i });
      out += source.slice(copiedUpTo, i) + blank(source.slice(i, literal.end));
      copiedUpTo = literal.end;
      i = literal.end;
      continue;
    }

    if (syntax.quotes.includes(source[i])) {
      // Copied verbatim: leaving it pending is enough, nothing is blanked here.
      const literal = findStringEnd(source, i, source[i], true);
      if (literal.ranToEndOfFile) unterminated.push({ kind: "string", offset: i });
      i = literal.end;
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
      if (closeAt === -1) unterminated.push({ kind: "block-comment", offset: i });
      const end = closeAt === -1 ? source.length : closeAt + close.length;
      out += source.slice(copiedUpTo, i) + blank(source.slice(i, end));
      copiedUpTo = end;
      i = end;
      continue;
    }

    i++;
  }

  return { source: out + source.slice(copiedUpTo), unterminated };
}
