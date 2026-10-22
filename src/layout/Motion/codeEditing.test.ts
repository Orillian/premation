import { indent, outdent, newline, toggleLineComment, lineOfOffset } from './codeEditing';

describe('expression editor code editing', () => {
  it('Tab at a caret inserts two spaces', () => {
    expect(indent('ab', 1, 1)).toEqual({ text: 'a  b', start: 3, end: 3 });
  });

  it('Tab over several lines indents each, Shift+Tab undoes it', () => {
    const src = 'var a = 1\nvar b = 2\nb';
    const r = indent(src, 0, 19);
    expect(r.text).toBe('  var a = 1\n  var b = 2\nb');
    const back = outdent(r.text, r.start, r.end);
    expect(back.text).toBe(src);
  });

  it('Shift+Tab on a caret line removes at most one indent', () => {
    expect(outdent('    x', 4, 4)).toEqual({ text: '  x', start: 2, end: 2 });
    expect(outdent('x', 1, 1).text).toBe('x');
  });

  it('Enter keeps the indentation and goes one deeper after a brace', () => {
    expect(newline('  a', 3, 3)).toEqual({ text: '  a\n  ', start: 6, end: 6 });
    expect(newline('if (x) {', 8, 8).text).toBe('if (x) {\n  ');
  });

  it('Enter between braces puts the closer on its own line', () => {
    const r = newline('f() {}', 5, 5);
    expect(r.text).toBe('f() {\n  \n}');
    expect(r.start).toBe(8);
  });

  it('Ctrl+/ comments and uncomments the touched lines', () => {
    const src = 'a\n  b';
    const on = toggleLineComment(src, 0, src.length);
    expect(on.text).toBe('// a\n  // b');
    expect(toggleLineComment(on.text, 0, on.text.length).text).toBe(src);
  });

  it('reports 1-based lines', () => {
    expect(lineOfOffset('a\nb\nc', 0)).toBe(1);
    expect(lineOfOffset('a\nb\nc', 4)).toBe(3);
  });
});
