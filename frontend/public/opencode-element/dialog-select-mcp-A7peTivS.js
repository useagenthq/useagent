import { cm as w, b$ as y, aC as d, at as c, L as S, b6 as r, a2 as b, b as k, bL as m, aR as L } from "./skynet-element-dDv65e_D.js";
import { S as M } from "./switch-BYCptXAS.js";
import { u as P } from "./mcp-DZ-Jnddv.js";
var j = /* @__PURE__ */ m('<span class="text-11-regular text-text-weaker">'), D = /* @__PURE__ */ m('<span class="text-11-regular text-text-weaker truncate">'), B = /* @__PURE__ */ m('<div class="w-full flex items-center justify-between gap-x-3"><div class="flex flex-col gap-0.5 min-w-0"><div class="flex items-center gap-2"><span class=truncate></span></div></div><div>');
const E = {
  connected: "mcp.status.connected",
  failed: "mcp.status.failed",
  needs_auth: "mcp.status.needs_auth",
  needs_client_registration: "mcp.status.needs_client_registration",
  disabled: "mcp.status.disabled"
}, T = () => {
  const g = w(), l = y(), o = d(() => Object.entries(g().data.mcp ?? {}).map(([e, a]) => ({
    name: e,
    status: a.status
  })).sort((e, a) => e.name.localeCompare(a.name))), n = P(), v = d(() => o().filter((e) => e.status === "connected").length), $ = d(() => o().length);
  return c(k, {
    get title() {
      return l.t("dialog.mcp.title");
    },
    get description() {
      return l.t("dialog.mcp.description", {
        enabled: v(),
        total: $()
      });
    },
    get children() {
      return c(S, {
        class: "px-3",
        get search() {
          return {
            placeholder: l.t("common.search.placeholder"),
            autofocus: !0
          };
        },
        get emptyMessage() {
          return l.t("dialog.mcp.empty");
        },
        key: (e) => e?.name ?? "",
        items: o,
        filterKeys: ["name", "status"],
        sortBy: (e, a) => e.name.localeCompare(a.name),
        onSelect: (e) => {
          !e || e.status === "pending" || n.isPending || n.mutate(e.name);
        },
        children: (e) => {
          const a = () => g().data.mcp[e.name], i = () => a()?.status, p = () => {
            const t = i() ? E[i()] : void 0;
            if (t)
              return l.t(t);
          }, f = () => {
            const t = a();
            if (t?.status === "failed" || t?.status === "needs_client_registration") return t.error;
          }, x = () => i() === "connected";
          return (() => {
            var t = B(), u = t.firstChild, h = u.firstChild, C = h.firstChild, _ = u.nextSibling;
            return r(C, () => e.name), r(h, c(b, {
              get when() {
                return p();
              },
              get children() {
                var s = j();
                return r(s, p), s;
              }
            }), null), r(u, c(b, {
              get when() {
                return f();
              },
              get children() {
                var s = D();
                return r(s, f), s;
              }
            }), null), _.$$click = (s) => s.stopPropagation(), r(_, c(M, {
              get checked() {
                return x();
              },
              get disabled() {
                return i() === "pending" || n.isPending && n.variables === e.name;
              },
              onChange: () => {
                n.isPending || n.mutate(e.name);
              }
            })), t;
          })();
        }
      });
    }
  });
};
L(["click"]);
export {
  T as DialogSelectMcp
};
