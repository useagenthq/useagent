import { aN as T, bb as m, bI as b, m as N, aK as F, ax as A, aM as $, az as H, aC as U, at as s, C as p, bc as h, ag as I, bd as R, p as j, bY as v, s as z, F as G, ay as Y, ar as J, cr as Q, r as V, q as W, au as X, aA as Z, an as ee, b7 as te, ba as oe, am as f, bU as ne, E as re, ae } from "./skynet-element-dDv65e_D.js";
var se = {};
ae(se, {
  Control: () => D,
  Description: () => O,
  ErrorMessage: () => _,
  Input: () => E,
  Label: () => L,
  Root: () => M,
  Switch: () => ie,
  Thumb: () => q,
  useSwitchContext: () => g
});
var P = X();
function g() {
  const o = ne(P);
  if (o === void 0)
    throw new Error("[kobalte]: `useSwitchContext` must be used within a `Switch` component");
  return o;
}
function D(o) {
  const t = v(), e = g(), i = m({
    id: e.generateId("control")
  }, o), [n, d] = b(i, ["onClick", "onKeyDown"]);
  return s(p, h({
    as: "div",
    onClick: (u) => {
      f(u, n.onClick), e.toggle(), e.inputRef()?.focus();
    },
    onKeyDown: (u) => {
      f(u, n.onKeyDown), u.key === re.Space && (e.toggle(), e.inputRef()?.focus());
    }
  }, () => t.dataset(), () => e.dataset(), d));
}
function O(o) {
  const t = g();
  return s(W, h(() => t.dataset(), o));
}
function _(o) {
  const t = g();
  return s(V, h(() => t.dataset(), o));
}
function E(o) {
  const t = v(), e = g(), i = m({
    id: e.generateId("input")
  }, o), [n, d, C] = b(i, ["ref", "style", "onChange", "onFocus", "onBlur"], G), {
    fieldProps: l
  } = Y(d);
  return s(p, h({
    as: "input",
    ref(r) {
      var a = R(e.setInputRef, n.ref);
      typeof a == "function" && a(r);
    },
    type: "checkbox",
    role: "switch",
    get id() {
      return l.id();
    },
    get name() {
      return t.name();
    },
    get value() {
      return e.value();
    },
    get checked() {
      return e.checked();
    },
    get required() {
      return t.isRequired();
    },
    get disabled() {
      return t.isDisabled();
    },
    get readonly() {
      return t.isReadOnly();
    },
    get style() {
      return J({
        ...Q
      }, n.style);
    },
    get "aria-checked"() {
      return e.checked();
    },
    get "aria-label"() {
      return l.ariaLabel();
    },
    get "aria-labelledby"() {
      return l.ariaLabelledBy();
    },
    get "aria-describedby"() {
      return l.ariaDescribedBy();
    },
    get "aria-invalid"() {
      return t.validationState() === "invalid" || void 0;
    },
    get "aria-required"() {
      return t.isRequired() || void 0;
    },
    get "aria-disabled"() {
      return t.isDisabled() || void 0;
    },
    get "aria-readonly"() {
      return t.isReadOnly() || void 0;
    },
    onChange: (r) => {
      f(r, n.onChange), r.stopPropagation();
      const a = r.target;
      e.setIsChecked(a.checked), a.checked = e.checked();
    },
    onFocus: (r) => {
      f(r, n.onFocus), e.setIsFocused(!0);
    },
    onBlur: (r) => {
      f(r, n.onBlur), e.setIsFocused(!1);
    }
  }, () => t.dataset(), () => e.dataset(), C));
}
function L(o) {
  const t = g();
  return s(z, h(() => t.dataset(), o));
}
function M(o) {
  let t;
  const e = `switch-${T()}`, i = m({
    value: "on",
    id: e
  }, o), [n, d, C] = b(i, ["ref", "children", "value", "checked", "defaultChecked", "onChange", "onPointerDown"], N), [l, u] = F(), [S, w] = F(!1), {
    formControlContext: r
  } = A(d), a = $({
    isSelected: () => n.checked,
    defaultIsSelected: () => n.defaultChecked,
    onSelectedChange: (c) => n.onChange?.(c),
    isDisabled: () => r.isDisabled(),
    isReadOnly: () => r.isReadOnly()
  });
  H(() => t, () => a.setIsSelected(n.defaultChecked ?? !1));
  const B = (c) => {
    f(c, n.onPointerDown), S() && c.preventDefault();
  }, y = U(() => ({
    "data-checked": a.isSelected() ? "" : void 0
  })), x = {
    value: () => n.value,
    dataset: y,
    checked: () => a.isSelected(),
    inputRef: l,
    generateId: Z(() => I(d.id)),
    toggle: () => a.toggle(),
    setIsChecked: (c) => a.setIsSelected(c),
    setIsFocused: w,
    setInputRef: u
  };
  return s(j.Provider, {
    value: r,
    get children() {
      return s(P.Provider, {
        value: x,
        get children() {
          return s(p, h({
            as: "div",
            ref(c) {
              var k = R((K) => t = K, n.ref);
              typeof k == "function" && k(c);
            },
            role: "group",
            get id() {
              return I(d.id);
            },
            onPointerDown: B
          }, () => r.dataset(), y, C, {
            get children() {
              return s(ce, {
                state: x,
                get children() {
                  return n.children;
                }
              });
            }
          }));
        }
      });
    }
  });
}
function ce(o) {
  const t = ee(() => {
    const e = o.children;
    return te(e) ? e(o.state) : e;
  });
  return oe(t);
}
function q(o) {
  const t = v(), e = g(), i = m({
    id: e.generateId("thumb")
  }, o);
  return s(p, h({
    as: "div"
  }, () => t.dataset(), () => e.dataset(), i));
}
var ie = Object.assign(M, {
  Control: D,
  Description: O,
  ErrorMessage: _,
  Input: E,
  Label: L,
  Thumb: q
});
export {
  ie as S
};
