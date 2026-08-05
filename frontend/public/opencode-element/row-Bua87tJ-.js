import { S as s } from "./LROKH5N7-C5nv-nud.js";
import { bI as c, at as t, bc as d, a2 as h, b6 as n, bL as g } from "./skynet-element-dDv65e_D.js";
function b(r) {
  const [e, i] = c(r, ["children", "class", "hideLabel"]);
  return t(s, d(i, {
    get class() {
      return e.class;
    },
    "data-component": "switch",
    get children() {
      return [t(s.Input, {
        "data-slot": "switch-input"
      }), t(h, {
        get when() {
          return e.children;
        },
        children: (a) => t(s.Label, {
          "data-slot": "switch-label",
          get classList() {
            return {
              "sr-only": e.hideLabel
            };
          },
          get children() {
            return a();
          }
        })
      }), t(s.Control, {
        "data-slot": "switch-control",
        get children() {
          return t(s.Thumb, {
            "data-slot": "switch-thumb"
          });
        }
      }), t(s.ErrorMessage, {
        "data-slot": "switch-error"
      })];
    }
  }));
}
var w = /* @__PURE__ */ g("<div data-component=settings-v2-row><div data-slot=settings-v2-row-copy><div data-slot=settings-v2-row-title></div><div data-slot=settings-v2-row-description></div></div><div data-slot=settings-v2-row-control>");
const m = (r) => (() => {
  var e = w(), i = e.firstChild, a = i.firstChild, l = a.nextSibling, o = i.nextSibling;
  return n(a, () => r.title), n(l, () => r.description), n(o, () => r.children), e;
})();
export {
  m as S,
  b as a
};
