/** Commit the typed title: take it and empty the box now, so the next title never meets a late clear. */
export async function commitTitle<R extends { ok: boolean }>(
  box: { value: string },
  add: (title: string) => Promise<R> | R,
): Promise<R> {
  const title = box.value;
  box.value = "";
  const r = await add(title);
  // A rejected title goes back, unless the person has already started typing the next one.
  if (!r.ok && box.value === "") box.value = title;
  return r;
}
