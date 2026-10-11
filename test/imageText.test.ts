import { expect, test } from "bun:test";
import { insertBlock, mapIndex, pickRange, swapHolder } from "../web/src/imageText";

const A = "![uploading image 1…]()";
const B = "![uploading image 2…]()";
const urlA = "![image](/api/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)";
const urlB = "![image](/api/attachments/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.png)";

test("insertBlock puts images on their own lines", () => {
  expect(insertBlock("", 0, 0, [A])).toEqual({ value: A, start: A.length, end: A.length });
  const r = insertBlock("see this. and more", 10, 10, [A, B]);
  expect(r.value).toBe(`see this. \n${A}\n${B}\nand more`);
  expect(r.value.slice(r.start)).toBe("and more");
  expect(insertBlock("line\n", 5, 5, [A]).value).toBe(`line\n${A}`);
});

test("insertBlock replaces the selection", () => {
  expect(insertBlock("abcXYZdef", 3, 6, [A]).value).toBe(`abc\n${A}\ndef`);
});

test("swapHolder moves a caret that sits after the holder", () => {
  const v = `hi\n${A}`;
  const r = swapHolder(v, A, urlA, v.length, v.length);
  expect(r).toEqual({ value: `hi\n${urlA}`, start: r.value.length, end: r.value.length });
  expect(swapHolder(v, A, urlA, 1, 1)).toMatchObject({ start: 1, end: 1 });
  expect(swapHolder(v, A, urlA, 5, 5).start).toBe(3 + urlA.length);
});

test("swapHolder on error drops the holder and its line break", () => {
  expect(swapHolder(`hi\n${A}\nbye`, A, "", 0, 0).value).toBe("hi\nbye");
  expect(swapHolder(`${A}\nbye`, A, "", 0, 0).value).toBe("bye");
  expect(swapHolder("unrelated", A, "", 2, 2)).toEqual({ value: "unrelated", start: 2, end: 2 });
});

test("mapIndex follows a swap the textarea has not rendered yet", () => {
  const shown = `x ${A} y`;
  const state = `x ${urlA} y`;
  expect(mapIndex(shown, state, 1)).toBe(1);
  expect(mapIndex(shown, state, shown.length)).toBe(state.length);
  expect(mapIndex(shown, state, 2)).toBe(2);
  expect(mapIndex(shown, state, 2 + A.length)).toBe(2 + urlA.length);
});

test("two pastes in a row, second before the first upload finishes, stay separate", () => {
  let e = insertBlock("it shows this. ", 15, 15, [A]);
  e = insertBlock(e.value, e.start, e.end, [B]);
  e = swapHolder(e.value, A, urlA, e.start, e.end);
  e = swapHolder(e.value, B, urlB, e.start, e.end);
  expect(e.value).toBe(`it shows this. \n${urlA}\n${urlB}`);
  expect(e.start).toBe(e.value.length);
});

test("second paste after the first upload landed goes after it", () => {
  let e = insertBlock("look", 4, 4, [A]);
  e = swapHolder(e.value, A, urlA, e.start, e.end);
  e = insertBlock(e.value, e.start, e.end, [B]);
  e = swapHolder(e.value, B, urlB, e.start, e.end);
  expect(e.value).toBe(`look\n${urlA}\n${urlB}`);
});

test("pickRange uses the selection only once the box was touched", () => {
  expect(pickRange(20, 0, 0, false)).toEqual([20, 20]);
  expect(pickRange(20, 5, 8, true)).toEqual([5, 8]);
  expect(pickRange(0, 0, 0, false)).toEqual([0, 0]);
});
