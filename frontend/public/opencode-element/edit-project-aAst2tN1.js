import { bV as D, bZ as C, aC as u, b0 as I, aL as F, c3 as h, bj as x } from "./skynet-element-dDv65e_D.js";
function L(t) {
  const s = D(), g = C(), i = u(() => g.ensureServerCtx(t.server)), d = u(() => I(t.project.worktree)), f = u(() => t.project.name || d()), [r, n] = F({
    name: f(),
    color: t.project.icon?.color,
    iconOverride: t.project.icon?.override,
    startup: t.project.commands?.start ?? "",
    dragOver: !1,
    iconHover: !1
  });
  let v;
  function m(e) {
    if (!e.type.startsWith("image/")) return;
    const o = new FileReader();
    o.onload = (a) => {
      const c = a.target?.result;
      typeof c == "string" && (n("iconOverride", c), n("iconHover", !1));
    }, o.readAsDataURL(e);
  }
  function O(e) {
    e.preventDefault(), n("dragOver", !1);
    const o = e.dataTransfer?.files[0];
    o && m(o);
  }
  function p(e) {
    e.preventDefault(), n("dragOver", !0);
  }
  function b() {
    n("dragOver", !1);
  }
  function k(e) {
    const o = e.currentTarget.files?.[0];
    o && m(o);
  }
  function w() {
    if (r.iconOverride && r.iconHover) {
      n("iconOverride", "");
      return;
    }
    v?.click();
  }
  const l = h(() => ({
    mutationFn: async () => {
      const e = r.name.trim() === d() ? "" : r.name.trim(), o = r.startup.trim();
      if (t.project.id && t.project.id !== "global") {
        if (await i().sdk.protocol !== "v1") return;
        const a = await i().sdk.client.project.update({
          projectID: t.project.id,
          directory: t.project.worktree,
          name: e,
          icon: { color: r.color || "", override: r.iconOverride || "" },
          commands: { start: o }
        }).then((c) => c.data);
        if (!a) return;
        i().sync.set(
          "project",
          (c) => c.map((j) => j.id === a.id ? x(a) : j)
        ), i().sync.project.icon(t.project.worktree, r.iconOverride || void 0), s.close();
        return;
      }
      i().sync.project.meta(t.project.worktree, {
        name: e,
        icon: { color: r.color || void 0, override: r.iconOverride || void 0 },
        commands: { start: o || void 0 }
      }), s.close();
    }
  }));
  function y(e) {
    e.preventDefault(), !l.isPending && l.mutate();
  }
  return {
    store: r,
    setStore: n,
    folderName: d,
    defaultName: f,
    save: l,
    submit: y,
    drop: O,
    dragOver: p,
    dragLeave: b,
    inputChange: k,
    iconClick: w,
    close() {
      s.close();
    },
    setIconInput(e) {
      v = e;
    }
  };
}
export {
  L as c
};
