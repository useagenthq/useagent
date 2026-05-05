import { bI as q, at as r, bc as W, a6 as le, b6 as a, b_ as Ze, bJ as Me, a2 as f, aH as ee, bF as ie, ao as Ue, bL as d, aR as oe, a9 as Y, a as V, bl as Ge, c6 as Ke, ch as ce, aC as E, cg as me, aI as Be, ck as fe, co as He, bm as Ye, bM as Je, bN as Qe, bO as Xe, be as et, bf as tt, bg as rt, bB as nt, bC as st, bD as it, S as at, bv as lt, b$ as O, c7 as re, bV as Z, aB as ot, ba as P, U as te, ab as de, cf as ct, ca as dt, bw as ae, o as z, N as se, bG as Q, c2 as gt, bp as ut, aL as be, z as vt, bX as ht, v as we, t as $e, R as N, aY as _e, c3 as Ne, aw as pt, c as X, f as mt, h as ft, k as bt, d as ke, ai as wt, e as De, cq as Se, bH as $t, x as A, V as je, Y as ze, ce as _t, bE as xe, _ as St, g as Ie, c0 as yt, cn as Ct, aK as kt, I as J, bK as Dt } from "./skynet-element-dDv65e_D.js";
import { S as I, a as R } from "./row-Bua87tJ-.js";
import { u as xt, S as It } from "./settings-keybinds-CZnVa_7L.js";
import { E as Pt, u as Tt, a as Lt, D as Et } from "./dialog-connect-provider-IYJDJgf0.js";
import { S as M } from "./list-Oo9-qh94.js";
var At = /* @__PURE__ */ d('<span class="inline-flex items-center gap-2"data-slot=tabs-v2-trigger-content>'), Ot = /* @__PURE__ */ d("<div data-slot=tabs-v2-trigger-wrapper>"), Rt = /* @__PURE__ */ d('<span data-slot=tabs-v2-subtext class="ms-2 text-xs text-text-weak">'), Vt = /* @__PURE__ */ d('<div role=button tabindex=0 data-slot=tabs-v2-close-button><svg width=14 height=14 viewBox="0 0 14 14"fill=none xmlns=http://www.w3.org/2000/svg><path d="M10.8889 3.11108L3.11108 10.8889"stroke=currentColor stroke-linejoin=round></path><path d="M3.11108 3.11108L10.8889 10.8889"stroke=currentColor stroke-linejoin=round>'), Ft = /* @__PURE__ */ d("<div data-slot=tabs-v2-section-title>");
function Mt(e) {
  const [t, n] = q(e, ["class", "classList", "variant", "orientation"]);
  return r(le, W(n, {
    get orientation() {
      return t.orientation;
    },
    "data-component": "tabs-v2",
    get "data-variant"() {
      return t.variant || "normal";
    },
    get "data-orientation"() {
      return t.orientation || "horizontal";
    },
    get classList() {
      return {
        ...t.classList,
        [t.class ?? ""]: !!t.class
      };
    }
  }));
}
function Bt(e) {
  const [t, n] = q(e, ["class", "classList"]);
  return r(le.List, W(n, {
    "data-slot": "tabs-v2-list",
    get classList() {
      return {
        ...t.classList,
        [t.class ?? ""]: !!t.class
      };
    }
  }));
}
function Nt(e) {
  const [t, n] = q(e, ["class", "classList", "children", "onMiddleClick", "subtext"]);
  return (() => {
    var s = Ot();
    return s.addEventListener("auxclick", (i) => {
      i.button === 1 && t.onMiddleClick && (i.preventDefault(), t.onMiddleClick());
    }), s.$$mousedown = (i) => {
      i.button === 1 && t.onMiddleClick && i.preventDefault();
    }, a(s, r(le.Trigger, W(n, {
      "data-slot": "tabs-v2-trigger",
      get "data-value"() {
        return e.value;
      },
      get children() {
        var i = At();
        return a(i, () => t.children, null), a(i, r(f, {
          get when() {
            return t.subtext;
          },
          children: (c) => (() => {
            var l = Rt();
            return a(l, c), l;
          })()
        }), null), i;
      }
    }))), ee((i) => {
      var c = e.value, l = {
        ...t.classList,
        [t.class ?? ""]: !!t.class
      };
      return c !== i.e && ie(s, "data-value", i.e = c), i.t = Ue(s, l, i.t), i;
    }, {
      e: void 0,
      t: void 0
    }), s;
  })();
}
function jt(e) {
  const t = Ze(), [n, s] = q(e, ["class", "classList", "onClick"]);
  return (() => {
    var i = Vt();
    return Me(i, W({
      get "aria-label"() {
        return t.t("ui.tabs.close");
      }
    }, s, {
      get classList() {
        return {
          [n.class ?? ""]: !!n.class,
          ...n.classList
        };
      },
      onClick: (c) => {
        c.preventDefault(), c.stopPropagation(), typeof n.onClick == "function" && n.onClick(c);
      },
      onMouseDown: (c) => {
        c.preventDefault(), c.stopPropagation();
      }
    }), !1, !0), i;
  })();
}
function zt(e) {
  const [t, n] = q(e, ["class", "classList", "children"]);
  return r(le.Content, W(n, {
    "data-slot": "tabs-v2-content",
    get classList() {
      return {
        ...t.classList,
        [t.class ?? ""]: !!t.class
      };
    },
    get children() {
      return t.children;
    }
  }));
}
const qt = (e) => (() => {
  var t = Ft();
  return a(t, () => e.children), t;
})(), F = Object.assign(Mt, {
  List: Bt,
  Trigger: Nt,
  CloseButton: jt,
  Content: zt,
  SectionTitle: qt
});
oe(["mousedown"]);
var Wt = /* @__PURE__ */ d("<div data-action=settings-new-layout-designs>"), Zt = /* @__PURE__ */ d("<div class=settings-v2-section><div class=settings-v2-interface-feature>"), Ut = /* @__PURE__ */ d('<span class="flex items-center gap-2">'), Gt = /* @__PURE__ */ d("<div class=settings-v2-section>");
function Kt(e) {
  return (() => {
    var t = Zt(), n = t.firstChild;
    return a(n, r(M, {
      get children() {
        return r(I, {
          get title() {
            return (() => {
              var s = Ut();
              return a(s, () => e.title, null), a(s, r(Y, {
                variant: "accent",
                get children() {
                  return e.badge;
                }
              }), null), s;
            })();
          },
          get description() {
            return e.description;
          },
          get children() {
            var s = Wt();
            return a(s, r(R, {
              get checked() {
                return e.checked;
              },
              get onChange() {
                return e.onChange;
              }
            })), s;
          }
        });
      }
    })), t;
  })();
}
function Ht(e) {
  return (() => {
    var t = Gt();
    return a(t, r(M, {
      get children() {
        return r(I, {
          get title() {
            return e.title;
          },
          get description() {
            return e.description;
          },
          get children() {
            return r(V, {
              size: "small",
              variant: "ghost-muted",
              get onClick() {
                return e.onDismiss;
              },
              get children() {
                return e.dismiss;
              }
            });
          }
        });
      }
    })), t;
  })();
}
function Yt(e) {
  const t = e.shells.reduce((s, i) => (s.set(i.name, (s.get(i.name) ?? 0) + 1), s), /* @__PURE__ */ new Map()), n = [
    { id: "auto", value: "", name: "", terminalOnly: !1 },
    ...e.shells.map((s) => {
      const i = (t.get(s.name) ?? 0) > 1, c = i ? s.path : s.name;
      return {
        id: s.path,
        value: i ? s.path : s.name,
        name: c,
        terminalOnly: !s.acceptable
      };
    })
  ];
  return e.current && !n.some((s) => s.value === e.current) && n.push({ id: e.current, value: e.current, name: e.current, terminalOnly: !1 }), n;
}
function Jt(e) {
  let t, n, s = 0;
  const i = () => {
    s += 1, t?.(), clearTimeout(n), t = void 0, n = void 0;
  }, c = (l) => {
    if (i(), !l) return;
    const o = ++s;
    n = setTimeout(() => {
      n = void 0, e(l).then((b) => {
        if (s === o) {
          t = b;
          return;
        }
        b?.();
      });
    }, 100);
  };
  return Ge(i), { play: c, stop: i };
}
function Qt(e) {
  const t = Ke(), n = ce(), s = E(() => {
    const i = e();
    if (i)
      return n().session.lineage.peek(i)?.session.directory;
  });
  return {
    accepting: E(() => {
      const i = e(), c = s();
      return !i || !c ? !1 : t.isAutoAccepting(i, c);
    }),
    enabled: E(() => !!s()),
    set: (i) => {
      const c = e(), l = s();
      if (!(!c || !l)) {
        if (i) return t.enableAutoAccept(c, l);
        t.disableAutoAccept(c, l);
      }
    }
  };
}
function Xt() {
  const e = me(), t = ce(), [n] = Be(
    async () => {
      const i = e();
      return await i.protocol === "v1" ? (await i.client.pty.shells()).data ?? [] : [];
    },
    { initialValue: [] }
  ), s = E(() => t().data.config.shell ?? "");
  return {
    shells: () => n.latest,
    current: s,
    select: (i) => {
      i !== s() && t().updateConfig({ shell: i });
    }
  };
}
function er() {
  const e = fe(), t = He(), n = E(() => t.ids().map((s) => ({ id: s, name: t.name(s) })));
  return Ye(() => void t.loadThemes()), {
    scheme: {
      current: t.colorScheme,
      select: (s) => t.setColorScheme(s)
    },
    theme: {
      options: n,
      current: E(() => n().find((s) => s.id === t.themeId())),
      select: (s) => s && t.setTheme(s.id)
    },
    fonts: {
      ui: E(() => ({
        value: it(e.appearance.uiFont()),
        family: st(e.appearance.uiFont()),
        placeholder: nt
      })),
      code: E(() => ({
        value: rt(e.appearance.font()),
        family: tt(e.appearance.font()),
        placeholder: et
      })),
      terminal: E(() => ({
        value: Xe(e.appearance.terminalFont()),
        family: Qe(e.appearance.terminalFont()),
        placeholder: Je
      })),
      setUI: (s) => e.appearance.setUIFont(s),
      setCode: (s) => e.appearance.setFont(s),
      setTerminal: (s) => e.appearance.setTerminalFont(s)
    }
  };
}
const pe = { id: "none", label: "sound.option.none" }, qe = [pe, ...at];
function tr() {
  const e = fe(), t = Jt(lt), n = (s, i, c, l) => ({
    current: E(
      () => s() ? qe.find((o) => o.id === i()) ?? pe : pe
    ),
    highlight: (o) => {
      o && t.play(o.id === "none" ? void 0 : o.id);
    },
    select: (o) => {
      if (o) {
        if (o.id === "none") {
          c(!1), t.stop();
          return;
        }
        c(!0), l(o.id), t.play(o.id);
      }
    }
  });
  return {
    agent: n(
      e.sounds.agentEnabled,
      e.sounds.agent,
      (s) => e.sounds.setAgentEnabled(s),
      (s) => e.sounds.setAgent(s)
    ),
    permissions: n(
      e.sounds.permissionsEnabled,
      e.sounds.permissions,
      (s) => e.sounds.setPermissionsEnabled(s),
      (s) => e.sounds.setPermissions(s)
    ),
    errors: n(
      e.sounds.errorsEnabled,
      e.sounds.errors,
      (s) => e.sounds.setErrorsEnabled(s),
      (s) => e.sounds.setErrors(s)
    )
  };
}
var rr = /* @__PURE__ */ d("<div data-action=settings-auto-accept-permissions>"), H = /* @__PURE__ */ d("<div class=settings-v2-section><h3 class=settings-v2-section-title>"), nr = /* @__PURE__ */ d('<div class="w-full sm:w-[220px]">'), sr = /* @__PURE__ */ d("<div data-action=settings-feed-reasoning-summaries>"), ir = /* @__PURE__ */ d("<div data-action=settings-feed-shell-tool-parts-expanded>"), ar = /* @__PURE__ */ d("<div data-action=settings-feed-edit-tool-parts-expanded>"), lr = /* @__PURE__ */ d("<div data-action=settings-mobile-titlebar-bottom>"), or = /* @__PURE__ */ d("<div class=settings-v2-section>"), cr = /* @__PURE__ */ d("<div data-action=settings-show-file-tree>"), dr = /* @__PURE__ */ d("<div data-action=settings-show-search>"), gr = /* @__PURE__ */ d("<div data-action=settings-show-status>"), ur = /* @__PURE__ */ d("<div data-action=settings-show-custom-agents>"), vr = /* @__PURE__ */ d("<div data-action=settings-notifications-agent>"), hr = /* @__PURE__ */ d("<div data-action=settings-notifications-permissions>"), pr = /* @__PURE__ */ d("<div data-action=settings-notifications-errors>"), mr = /* @__PURE__ */ d("<div data-action=settings-release-notes>"), fr = /* @__PURE__ */ d("<div data-action=settings-pinch-zoom>"), br = /* @__PURE__ */ d("<div class=settings-v2-tab-header><h2 class=settings-v2-tab-title>"), wr = /* @__PURE__ */ d("<div class=settings-v2-tab-body>");
const Pe = ["system", "light", "dark"], $r = {
  ui: {
    action: "settings-ui-font",
    title: "settings.general.row.uiFont.title",
    description: "settings.general.row.uiFont.description",
    font: "ui",
    input: "setUI"
  },
  code: {
    action: "settings-code-font",
    title: "settings.general.row.font.title",
    description: "settings.general.row.font.description",
    font: "code",
    input: "setCode"
  },
  terminal: {
    action: "settings-terminal-font",
    title: "settings.general.row.terminalFont.title",
    description: "settings.general.row.terminalFont.description",
    font: "terminal",
    input: "setTerminal"
  }
}, _r = {
  agent: {
    action: "settings-sounds-agent",
    title: "settings.general.sounds.agent.title",
    description: "settings.general.sounds.agent.description"
  },
  permissions: {
    action: "settings-sounds-permissions",
    title: "settings.general.sounds.permissions.title",
    description: "settings.general.sounds.permissions.description"
  },
  errors: {
    action: "settings-sounds-errors",
    title: "settings.general.sounds.errors.title",
    description: "settings.general.sounds.errors.description"
  }
}, Sr = (e) => {
  const t = O();
  return r(I, {
    get title() {
      return t.t("command.permissions.autoaccept.enable");
    },
    get description() {
      return t.t("toast.permissions.autoaccept.on.description");
    },
    get children() {
      var n = rr();
      return a(n, r(R, {
        get checked() {
          return e.controller.accepting();
        },
        get disabled() {
          return !e.controller.enabled();
        },
        get onChange() {
          return e.controller.set;
        }
      })), n;
    }
  });
}, yr = (e) => {
  const t = O(), n = E(() => Yt({
    shells: e.controller.shells(),
    current: e.controller.current()
  }));
  return r(I, {
    get title() {
      return t.t("settings.general.row.shell.title");
    },
    get description() {
      return t.t("settings.general.row.shell.description");
    },
    get children() {
      return r(te, {
        appearance: "inline",
        "data-action": "settings-shell",
        get options() {
          return n();
        },
        get current() {
          return n().find((s) => s.value === e.controller.current()) ?? n()[0];
        },
        placement: "bottom-end",
        gutter: 6,
        value: (s) => s.id,
        label: (s) => s.id === "auto" ? t.t("settings.general.row.shell.autoDefault") : s.terminalOnly ? `${s.name} (${t.t("settings.general.row.shell.terminalOnly")})` : s.name,
        onSelect: (s) => s && e.controller.select(s.value)
      });
    }
  });
}, Cr = (e) => {
  const t = O();
  return (() => {
    var n = H(), s = n.firstChild;
    return a(s, () => t.t("settings.general.section.appearance")), a(n, r(M, {
      get children() {
        return [r(I, {
          get title() {
            return t.t("settings.general.row.colorScheme.title");
          },
          get description() {
            return t.t("settings.general.row.colorScheme.description");
          },
          get children() {
            return r(te, {
              appearance: "inline",
              "data-action": "settings-color-scheme",
              options: Pe,
              get current() {
                return Pe.find((i) => i === e.controller.scheme.current());
              },
              placement: "bottom-end",
              gutter: 6,
              label: (i) => i === "system" ? t.t("theme.scheme.system") : i === "light" ? t.t("theme.scheme.light") : t.t("theme.scheme.dark"),
              onSelect: (i) => i && e.controller.scheme.select(i)
            });
          }
        }), r(I, {
          get title() {
            return t.t("settings.general.row.theme.title");
          },
          get description() {
            return [P(() => t.t("settings.general.row.theme.description")), " ", r(Pt, {
              class: "settings-v2-link",
              href: "https://opencode.ai/docs/themes/",
              get children() {
                return t.t("common.learnMore");
              }
            })];
          },
          get children() {
            return r(te, {
              appearance: "inline",
              "data-action": "settings-theme",
              get options() {
                return e.controller.theme.options();
              },
              get current() {
                return e.controller.theme.current();
              },
              placement: "bottom-end",
              gutter: 6,
              value: (i) => i.id,
              label: (i) => i.name,
              get onSelect() {
                return e.controller.theme.select;
              }
            });
          }
        }), r(ge, {
          kind: "ui",
          get fonts() {
            return e.controller.fonts;
          }
        }), r(ge, {
          kind: "code",
          get fonts() {
            return e.controller.fonts;
          }
        }), r(ge, {
          kind: "terminal",
          get fonts() {
            return e.controller.fonts;
          }
        })];
      }
    }), null), n;
  })();
}, ge = (e) => {
  const t = O(), n = () => $r[e.kind];
  return r(I, {
    get title() {
      return t.t(n().title);
    },
    get description() {
      return t.t(n().description);
    },
    get children() {
      var s = nr();
      return a(s, r(de, {
        get "data-action"() {
          return n().action;
        },
        type: "text",
        appearance: "base",
        get value() {
          return e.fonts[n().font]().value;
        },
        onInput: (i) => e.fonts[n().input](i.currentTarget.value),
        get placeholder() {
          return e.fonts[n().font]().placeholder;
        },
        spellcheck: !1,
        autocorrect: "off",
        autocomplete: "off",
        autocapitalize: "off",
        get "aria-label"() {
          return t.t(n().title);
        },
        get style() {
          return {
            "font-family": e.fonts[n().font]().family
          };
        }
      })), s;
    }
  });
}, kr = (e) => {
  const t = O();
  return (() => {
    var n = H(), s = n.firstChild;
    return a(s, () => t.t("settings.general.section.sounds")), a(n, r(M, {
      get children() {
        return [r(ue, {
          kind: "agent",
          get channel() {
            return e.controller.agent;
          }
        }), r(ue, {
          kind: "permissions",
          get channel() {
            return e.controller.permissions;
          }
        }), r(ue, {
          kind: "errors",
          get channel() {
            return e.controller.errors;
          }
        })];
      }
    }), null), n;
  })();
}, ue = (e) => {
  const t = O(), n = () => _r[e.kind];
  return r(I, {
    get title() {
      return t.t(n().title);
    },
    get description() {
      return t.t(n().description);
    },
    get children() {
      return r(te, {
        appearance: "inline",
        get "data-action"() {
          return n().action;
        },
        options: qe,
        get current() {
          return e.channel.current();
        },
        value: (s) => s.id,
        label: (s) => t.t(s.label),
        get onHighlight() {
          return e.channel.highlight;
        },
        get onSelect() {
          return e.channel.select;
        },
        placement: "bottom-end",
        gutter: 6
      });
    }
  });
}, Dr = () => {
  const e = O(), t = E(() => e.locales.map((n) => ({
    value: n,
    label: e.label(n)
  })));
  return r(I, {
    get title() {
      return e.t("settings.general.row.language.title");
    },
    get description() {
      return e.t("settings.general.row.language.description");
    },
    get children() {
      return r(te, {
        appearance: "inline",
        "data-action": "settings-language",
        get options() {
          return t();
        },
        placement: "bottom-end",
        gutter: 6,
        get current() {
          return t().find((n) => n.value === e.locale());
        },
        value: (n) => n.value,
        label: (n) => n.label,
        onSelect: (n) => n && e.setLocale(n.value)
      });
    }
  });
}, xr = (e) => {
  const t = O(), n = re(), s = Z(), i = fe(), c = ot("(max-width: 767px)"), l = xt(), o = Qt(() => e.sessionID), b = Xt(), $ = er(), w = tr(), u = E(() => n.platform === "desktop"), [p, {
    mutate: _
  }] = Be(() => u() && "getPinchZoomEnabled" in n, () => Promise.resolve(n.getPinchZoomEnabled?.() ?? !1).catch(() => !1), {
    initialValue: !1
  }), x = (h) => {
    _(h);
    const y = n.setPinchZoomEnabled?.(h);
    y && y.catch(() => _(!h));
  }, T = () => r(Kt, {
    get title() {
      return t.t("settings.general.row.newInterface.title");
    },
    get badge() {
      return t.t("settings.general.row.newInterface.badge");
    },
    get description() {
      return t.t("settings.general.row.newInterface.description");
    },
    get checked() {
      return i.general.newLayoutDesigns();
    },
    onChange: (h) => {
      i.general.setNewLayoutDesigns(h), !h && import("./dialog-settings-kSS0oPA8.js").then((y) => {
        s.show(() => r(y.DialogSettings, {}));
      });
    }
  }), k = () => r(Ht, {
    get title() {
      return t.t("settings.general.row.newInterfaceNotice.title");
    },
    get description() {
      return t.t("settings.general.row.newInterfaceNotice.description");
    },
    get dismiss() {
      return t.t("settings.general.row.newInterfaceNotice.dismiss");
    },
    onDismiss: () => i.general.dismissNewInterfaceNotice()
  }), L = () => (() => {
    var h = or();
    return a(h, r(M, {
      get children() {
        return [r(Dr, {}), r(Sr, {
          controller: o
        }), r(yr, {
          controller: b
        }), r(I, {
          get title() {
            return t.t("settings.general.row.reasoningSummaries.title");
          },
          get description() {
            return t.t("settings.general.row.reasoningSummaries.description");
          },
          get children() {
            var y = sr();
            return a(y, r(R, {
              get checked() {
                return i.general.showReasoningSummaries();
              },
              onChange: (g) => i.general.setShowReasoningSummaries(g)
            })), y;
          }
        }), r(I, {
          get title() {
            return t.t("settings.general.row.shellToolPartsExpanded.title");
          },
          get description() {
            return t.t("settings.general.row.shellToolPartsExpanded.description");
          },
          get children() {
            var y = ir();
            return a(y, r(R, {
              get checked() {
                return i.general.shellToolPartsExpanded();
              },
              onChange: (g) => i.general.setShellToolPartsExpanded(g)
            })), y;
          }
        }), r(I, {
          get title() {
            return t.t("settings.general.row.editToolPartsExpanded.title");
          },
          get description() {
            return t.t("settings.general.row.editToolPartsExpanded.description");
          },
          get children() {
            var y = ar();
            return a(y, r(R, {
              get checked() {
                return i.general.editToolPartsExpanded();
              },
              onChange: (g) => i.general.setEditToolPartsExpanded(g)
            })), y;
          }
        }), r(f, {
          get when() {
            return P(() => !!c())() && !0;
          },
          get children() {
            return r(I, {
              get title() {
                return t.t("settings.general.row.mobileTitlebarBottom.title");
              },
              get description() {
                return t.t("settings.general.row.mobileTitlebarBottom.description");
              },
              get children() {
                var y = lr();
                return a(y, r(R, {
                  get checked() {
                    return i.general.mobileTitlebarPosition() === "bottom";
                  },
                  onChange: (g) => i.general.setMobileTitlebarPosition(g ? "bottom" : "top")
                })), y;
              }
            });
          }
        })];
      }
    })), h;
  })(), m = () => (() => {
    var h = H(), y = h.firstChild;
    return a(y, () => t.t("settings.general.section.advanced")), a(h, r(M, {
      get children() {
        return [r(I, {
          get title() {
            return t.t("settings.general.row.showFileTree.title");
          },
          get description() {
            return t.t("settings.general.row.showFileTree.description");
          },
          get children() {
            var g = cr();
            return a(g, r(R, {
              get checked() {
                return i.general.showFileTree();
              },
              onChange: (D) => i.general.setShowFileTree(D)
            })), g;
          }
        }), r(I, {
          get title() {
            return t.t("settings.general.row.showSearch.title");
          },
          get description() {
            return t.t("settings.general.row.showSearch.description");
          },
          get children() {
            var g = dr();
            return a(g, r(R, {
              get checked() {
                return i.general.showSearch();
              },
              onChange: (D) => i.general.setShowSearch(D)
            })), g;
          }
        }), r(I, {
          get title() {
            return t.t("settings.general.row.showStatus.title");
          },
          get description() {
            return t.t("settings.general.row.showStatus.description");
          },
          get children() {
            var g = gr();
            return a(g, r(R, {
              get checked() {
                return i.general.showStatus();
              },
              onChange: (D) => i.general.setShowStatus(D)
            })), g;
          }
        }), r(I, {
          get title() {
            return t.t("settings.general.row.showCustomAgents.title");
          },
          get description() {
            return t.t("settings.general.row.showCustomAgents.description");
          },
          get children() {
            var g = ur();
            return a(g, r(R, {
              get checked() {
                return i.general.showCustomAgents();
              },
              onChange: (D) => i.general.setShowCustomAgents(D)
            })), g;
          }
        })];
      }
    }), null), h;
  })(), v = () => (() => {
    var h = H(), y = h.firstChild;
    return a(y, () => t.t("settings.general.section.notifications")), a(h, r(M, {
      get children() {
        return [r(I, {
          get title() {
            return t.t("settings.general.notifications.agent.title");
          },
          get description() {
            return t.t("settings.general.notifications.agent.description");
          },
          get children() {
            var g = vr();
            return a(g, r(R, {
              get checked() {
                return i.notifications.agent();
              },
              onChange: (D) => i.notifications.setAgent(D)
            })), g;
          }
        }), r(I, {
          get title() {
            return t.t("settings.general.notifications.permissions.title");
          },
          get description() {
            return t.t("settings.general.notifications.permissions.description");
          },
          get children() {
            var g = hr();
            return a(g, r(R, {
              get checked() {
                return i.notifications.permissions();
              },
              onChange: (D) => i.notifications.setPermissions(D)
            })), g;
          }
        }), r(I, {
          get title() {
            return t.t("settings.general.notifications.errors.title");
          },
          get description() {
            return t.t("settings.general.notifications.errors.description");
          },
          get children() {
            var g = pr();
            return a(g, r(R, {
              get checked() {
                return i.notifications.errors();
              },
              onChange: (D) => i.notifications.setErrors(D)
            })), g;
          }
        })];
      }
    }), null), h;
  })(), C = () => (() => {
    var h = H(), y = h.firstChild;
    return a(y, () => t.t("settings.general.section.updates")), a(h, r(M, {
      get children() {
        return [r(I, {
          get title() {
            return t.t("settings.general.row.releaseNotes.title");
          },
          get description() {
            return t.t("settings.general.row.releaseNotes.description");
          },
          get children() {
            var g = mr();
            return a(g, r(R, {
              get checked() {
                return i.general.releaseNotes();
              },
              onChange: (D) => i.general.setReleaseNotes(D)
            })), g;
          }
        }), r(I, {
          get title() {
            return t.t("settings.updates.row.check.title");
          },
          get description() {
            return t.t("settings.updates.row.check.description");
          },
          get children() {
            return r(V, {
              size: "normal",
              variant: "neutral",
              get disabled() {
                return !l.action().run;
              },
              onClick: () => l.run(),
              get children() {
                return t.t(l.action().label);
              }
            });
          }
        })];
      }
    }), null), h;
  })(), S = () => r(f, {
    get when() {
      return u();
    },
    get children() {
      var h = H(), y = h.firstChild;
      return a(y, () => t.t("settings.general.section.display")), a(h, r(M, {
        get children() {
          return r(I, {
            get title() {
              return t.t("settings.general.row.pinchZoom.title");
            },
            get description() {
              return t.t("settings.general.row.pinchZoom.description");
            },
            get children() {
              var g = fr();
              return a(g, r(R, {
                get checked() {
                  return p.latest;
                },
                onChange: x
              })), g;
            }
          });
        }
      }), null), h;
    }
  });
  return [(() => {
    var h = br(), y = h.firstChild;
    return a(y, () => t.t("settings.tab.general")), h;
  })(), (() => {
    var h = wr();
    return a(h, r(f, {
      get when() {
        return i.general.layoutTransitionAvailable();
      },
      get children() {
        return r(T, {});
      }
    }), null), a(h, r(f, {
      get when() {
        return i.general.newInterfaceNoticeVisible();
      },
      get children() {
        return r(k, {});
      }
    }), null), a(h, r(L, {}), null), a(h, r(Cr, {
      controller: $
    }), null), a(h, r(v, {}), null), a(h, r(kr, {
      controller: w
    }), null), a(h, r(f, {
      get when() {
        return u();
      },
      get children() {
        return r(C, {});
      }
    }), null), a(h, r(S, {}), null), a(h, r(m, {}), null), h;
  })()];
};
var Ir = /* @__PURE__ */ d("<div class=settings-v2-tab-header><h2 class=settings-v2-tab-title>"), Pr = /* @__PURE__ */ d("<div class=settings-v2-provider-row data-component=custom-provider-section><div class=settings-v2-provider-lead><div class=settings-v2-provider-copy><div class=settings-v2-provider-main><span class=settings-v2-provider-name></span></div><p class=settings-v2-provider-description>"), Tr = /* @__PURE__ */ d('<div class="settings-v2-tab-body settings-v2-providers"><div class=settings-v2-section data-component=connected-providers-section><h3 class=settings-v2-section-title></h3></div><div class=settings-v2-section><h3 class=settings-v2-section-title></h3><button type=button class=settings-v2-providers-view-all>'), Lr = /* @__PURE__ */ d("<div class=settings-v2-provider-empty>"), Er = /* @__PURE__ */ d('<div class="settings-v2-provider-row group"><div class=settings-v2-provider-lead><div class=settings-v2-provider-main><span class="settings-v2-provider-name truncate">'), Ar = /* @__PURE__ */ d("<span class=settings-v2-provider-env-hint>"), Or = /* @__PURE__ */ d("<div class=settings-v2-provider-row><div class=settings-v2-provider-lead><div class=settings-v2-provider-copy><div class=settings-v2-provider-main><span class=settings-v2-provider-name>"), Rr = /* @__PURE__ */ d("<p class=settings-v2-provider-description>");
const Vr = [{
  match: (e) => e === "opencode",
  key: "dialog.provider.opencode.note"
}, {
  match: (e) => e === "opencode-go",
  key: "dialog.provider.opencodeGo.tagline"
}, {
  match: (e) => e === "anthropic",
  key: "dialog.provider.anthropic.note"
}, {
  match: (e) => e.startsWith("github-copilot"),
  key: "dialog.provider.copilot.note"
}, {
  match: (e) => e === "openai",
  key: "dialog.provider.openai.note"
}, {
  match: (e) => e === "google",
  key: "dialog.provider.google.note"
}, {
  match: (e) => e === "openrouter",
  key: "dialog.provider.openrouter.note"
}, {
  match: (e) => e === "vercel",
  key: "dialog.provider.vercel.note"
}], K = 16, Fr = (e) => {
  const t = Z(), n = O(), s = me(), i = ct(), c = ce(), l = dt(e.directory), o = Tt({
    onBack: e.onBack
  }), b = (m) => {
    o.select(m), t.show(() => r(Et, {
      get directory() {
        return e.directory;
      },
      controller: o
    }));
  }, $ = E(() => l.connected().filter((m) => m.id !== "opencode" || Object.values(m.models).find((v) => v.cost?.input))), w = E(() => {
    const m = new Set($().map((C) => C.id)), v = l.popular().filter((C) => !m.has(C.id)).slice();
    return v.sort((C, S) => ae.indexOf(C.id) - ae.indexOf(S.id)), v;
  }), u = (m) => {
    if (!("source" in m)) return;
    const v = m.source;
    if (v === "env" || v === "api" || v === "config" || v === "custom") return v;
  }, p = (m) => {
    const v = u(m);
    return v === "env" ? n.t("settings.providers.tag.environment") : v === "api" ? n.t("provider.connect.method.apiKey") : v === "config" ? T(m.id) ? n.t("settings.providers.tag.custom") : n.t("settings.providers.tag.config") : v === "custom" ? n.t("settings.providers.tag.custom") : n.t("settings.providers.tag.other");
  }, _ = (m) => u(m) !== "env" && (i() === "v1" || !T(m.id)), x = (m) => Vr.find((v) => v.match(m))?.key, T = (m) => {
    const v = c().data.config.provider?.[m];
    return !(!v || v.npm !== "@ai-sdk/openai-compatible" || !v.models || Object.keys(v.models).length === 0);
  }, k = async (m, v) => {
    if (i() !== "v1") return;
    const C = c().data.config.disabled_providers ?? [], S = C.includes(m) ? C : [...C, m];
    c().set("config", "disabled_providers", S), await c().updateConfig({
      disabled_providers: S
    }).then(() => {
      Q({
        variant: "success",
        icon: "circle-check",
        title: n.t("provider.disconnect.toast.disconnected.title", {
          provider: v
        }),
        description: n.t("provider.disconnect.toast.disconnected.description", {
          provider: v
        })
      });
    }).catch((h) => {
      c().set("config", "disabled_providers", C);
      const y = h instanceof Error ? h.message : String(h);
      Q({
        title: n.t("common.requestFailed"),
        description: y
      });
    });
  }, L = async (m, v) => {
    if (T(m)) {
      await s().client.auth.remove({
        providerID: m
      }).catch(() => {
      }), await k(m, v);
      return;
    }
    await s().client.auth.remove({
      providerID: m
    }).then(async () => {
      await s().client.global.dispose(), Q({
        variant: "success",
        icon: "circle-check",
        title: n.t("provider.disconnect.toast.disconnected.title", {
          provider: v
        }),
        description: n.t("provider.disconnect.toast.disconnected.description", {
          provider: v
        })
      });
    }).catch((C) => {
      const S = C instanceof Error ? C.message : String(C);
      Q({
        title: n.t("common.requestFailed"),
        description: S
      });
    });
  };
  return [(() => {
    var m = Ir(), v = m.firstChild;
    return a(v, () => n.t("settings.providers.title")), m;
  })(), (() => {
    var m = Tr(), v = m.firstChild, C = v.firstChild, S = v.nextSibling, h = S.firstChild, y = h.nextSibling;
    return a(C, () => n.t("settings.providers.section.connected")), a(v, r(M, {
      get children() {
        return r(f, {
          get when() {
            return $().length > 0;
          },
          get fallback() {
            return (() => {
              var g = Lr();
              return a(g, () => n.t("settings.providers.connected.empty")), g;
            })();
          },
          get children() {
            return r(z, {
              get each() {
                return $();
              },
              children: (g) => (() => {
                var D = Er(), j = D.firstChild, B = j.firstChild, U = B.firstChild;
                return a(j, r(se, {
                  get id() {
                    return g.id;
                  },
                  width: K,
                  height: K,
                  class: "settings-v2-provider-icon shrink-0"
                }), B), a(U, () => g.name), a(B, r(Y, {
                  get children() {
                    return p(g);
                  }
                }), null), a(D, r(f, {
                  get when() {
                    return _(g);
                  },
                  get fallback() {
                    return (() => {
                      var G = Ar();
                      return a(G, () => n.t("settings.providers.connected.environmentDescription")), G;
                    })();
                  },
                  get children() {
                    return r(V, {
                      size: "normal",
                      variant: "ghost-muted",
                      onClick: () => void L(g.id, g.name),
                      get children() {
                        return n.t("common.disconnect");
                      }
                    });
                  }
                }), null), D;
              })()
            });
          }
        });
      }
    }), null), a(h, () => n.t("settings.providers.section.popular")), a(S, r(M, {
      get children() {
        return [r(z, {
          get each() {
            return w();
          },
          children: (g) => (() => {
            var D = Or(), j = D.firstChild, B = j.firstChild, U = B.firstChild, G = U.firstChild;
            return a(j, r(se, {
              get id() {
                return g.id;
              },
              width: K,
              height: K,
              class: "settings-v2-provider-icon shrink-0"
            }), B), a(G, () => g.name), a(U, r(f, {
              get when() {
                return g.id === "opencode" || g.id === "opencode-go";
              },
              get children() {
                return r(Y, {
                  get children() {
                    return n.t("dialog.provider.tag.recommended");
                  }
                });
              }
            }), null), a(B, r(f, {
              get when() {
                return x(g.id);
              },
              children: (We) => (() => {
                var Ce = Rr();
                return a(Ce, () => n.t(We())), Ce;
              })()
            }), null), a(D, r(V, {
              size: "normal",
              variant: "neutral",
              icon: "plus",
              onClick: () => b(g.id),
              get children() {
                return n.t("common.connect");
              }
            }), null), D;
          })()
        }), r(f, {
          get when() {
            return i() === "v1";
          },
          get children() {
            var g = Pr(), D = g.firstChild, j = D.firstChild, B = j.firstChild, U = B.firstChild, G = B.nextSibling;
            return a(D, r(se, {
              id: "synthetic",
              width: K,
              height: K,
              class: "settings-v2-provider-icon shrink-0"
            }), j), a(U, () => n.t("provider.custom.title")), a(B, r(Y, {
              get children() {
                return n.t("settings.providers.tag.custom");
              }
            }), null), a(G, () => n.t("settings.providers.custom.description")), a(g, r(V, {
              size: "normal",
              variant: "neutral",
              icon: "plus",
              onClick: () => {
                t.show(() => r(Lt, {
                  get onBack() {
                    return t.close;
                  }
                }));
              },
              get children() {
                return n.t("common.connect");
              }
            }), null), g;
          }
        })];
      }
    }), y), y.$$click = () => b(), a(y, () => n.t("dialog.provider.viewAll")), m;
  })()];
};
oe(["click"]);
var Mr = /* @__PURE__ */ d('<div class="settings-v2-tab-header settings-v2-tab-header--stacked"><h2 class=settings-v2-tab-title></h2><div class=settings-v2-tab-search>'), Br = /* @__PURE__ */ d('<div class="settings-v2-tab-body settings-v2-models">'), Nr = /* @__PURE__ */ d("<div class=settings-v2-models-status>"), jr = /* @__PURE__ */ d("<span class=settings-v2-models-status-filter>&quot;<!>&quot;"), zr = /* @__PURE__ */ d("<div class=settings-v2-models-status><span>"), qr = /* @__PURE__ */ d('<svg width=16 height=16 viewBox="0 0 16 16"fill=none aria-hidden=true><path d="M5.37624 6.75194C5.18184 6.41861 5.42224 6 5.80814 6H10.1921C10.578 6 10.8184 6.41861 10.624 6.75194L8.43203 10.5096C8.23909 10.8404 7.76119 10.8404 7.56825 10.5096L5.37624 6.75194Z"fill=currentColor>'), Wr = /* @__PURE__ */ d("<div class=settings-v2-section data-component=settings-models-provider><h3 class=settings-v2-models-group-header><button type=button class=settings-v2-models-group-trigger><span class=settings-v2-models-group-chevron></span><span class=settings-v2-models-group-label><span class=settings-v2-section-title>"), Zr = /* @__PURE__ */ d('<svg width=5 height=6 viewBox="0 0 5 6"fill=none aria-hidden=true><path d="M0.75194 5.31663C0.41861 5.51103 0 5.27063 0 4.88473V0.500754C0 0.114854 0.41861 -0.125577 0.75194 0.0688635L4.5096 2.26084C4.8404 2.45378 4.8404 2.93168 4.5096 3.12462L0.75194 5.31663Z"fill=currentColor>'), Ur = /* @__PURE__ */ d("<div>");
const Te = 16, Gr = () => {
  const e = O(), t = gt(), n = me(), [s, i] = ut(vt.serverGlobal(n().scope, "settings-v2.models.providers"), be({
    collapsed: {}
  })), c = ht({
    items: (l) => t.list(),
    key: (l) => `${l.provider.id}:${l.id}`,
    filterKeys: ["provider.name", "name", "id"],
    sortBy: (l, o) => l.name.localeCompare(o.name),
    groupBy: (l) => l.provider.id,
    sortGroupsBy: (l, o) => {
      const b = ae.indexOf(l.category), $ = ae.indexOf(o.category), w = b >= 0, u = $ >= 0;
      if (w && !u) return -1;
      if (!w && u) return 1;
      if (w && u) return b - $;
      const p = l.items[0].provider.name, _ = o.items[0].provider.name;
      return p.localeCompare(_);
    }
  });
  return [(() => {
    var l = Mr(), o = l.firstChild, b = o.nextSibling;
    return a(o, () => e.t("settings.models.title")), a(b, r(de, {
      type: "search",
      appearance: "base",
      get value() {
        return c.filter();
      },
      onInput: ($) => c.onInput($.currentTarget.value),
      get placeholder() {
        return e.t("dialog.model.search.placeholder");
      },
      spellcheck: !1,
      autocorrect: "off",
      autocomplete: "off",
      autocapitalize: "off",
      get "aria-label"() {
        return e.t("dialog.model.search.placeholder");
      }
    }), null), a(b, r(f, {
      get when() {
        return c.filter();
      },
      get children() {
        return r(we, {
          type: "button",
          variant: "ghost-muted",
          size: "small",
          class: "settings-v2-tab-search-clear",
          get icon() {
            return r($e, {
              name: "close",
              size: "large",
              class: "text-v2-icon-icon-muted"
            });
          },
          onClick: () => c.clear()
        });
      }
    }), null), l;
  })(), (() => {
    var l = Br();
    return a(l, r(f, {
      get when() {
        return !c.grouped.loading;
      },
      get fallback() {
        return (() => {
          var o = Nr();
          return a(o, () => e.t("common.loading"), null), a(o, () => e.t("common.loading.ellipsis"), null), o;
        })();
      },
      get children() {
        return r(f, {
          get when() {
            return c.flat().length > 0;
          },
          get fallback() {
            return (() => {
              var o = zr(), b = o.firstChild;
              return a(b, () => e.t("dialog.model.empty")), a(o, r(f, {
                get when() {
                  return c.filter();
                },
                get children() {
                  var $ = jr(), w = $.firstChild, u = w.nextSibling;
                  return u.nextSibling, a($, () => c.filter(), u), $;
                }
              }), null), o;
            })();
          },
          get children() {
            return r(z, {
              get each() {
                return c.grouped.latest;
              },
              children: (o) => {
                const b = () => c.filter().length > 0, $ = () => b() || !s.collapsed[o.category];
                return (() => {
                  var w = Wr(), u = w.firstChild, p = u.firstChild, _ = p.firstChild, x = _.nextSibling, T = x.firstChild;
                  return p.$$click = () => i("collapsed", o.category, $()), a(_, r(f, {
                    get when() {
                      return $();
                    },
                    get fallback() {
                      return Zr();
                    },
                    get children() {
                      return qr();
                    }
                  })), a(x, r(se, {
                    get id() {
                      return o.category;
                    },
                    width: Te,
                    height: Te,
                    class: "settings-v2-models-provider-icon shrink-0"
                  }), T), a(T, () => o.items[0].provider.name), a(w, r(f, {
                    get when() {
                      return $();
                    },
                    get children() {
                      return r(M, {
                        get children() {
                          return r(z, {
                            get each() {
                              return o.items;
                            },
                            children: (k) => {
                              const L = {
                                providerID: k.provider.id,
                                modelID: k.id
                              };
                              return r(I, {
                                get title() {
                                  return k.name;
                                },
                                description: "",
                                get children() {
                                  var m = Ur();
                                  return a(m, r(R, {
                                    get checked() {
                                      return t.visible(L);
                                    },
                                    onChange: (v) => {
                                      t.setVisibility(L, v);
                                    },
                                    hideLabel: !0,
                                    get children() {
                                      return k.name;
                                    }
                                  })), m;
                                }
                              });
                            }
                          });
                        }
                      });
                    }
                  }), null), ee((k) => {
                    var L = $() ? "" : void 0, m = $(), v = b();
                    return L !== k.e && ie(w, "data-expanded", k.e = L), m !== k.t && ie(p, "aria-expanded", k.t = m), v !== k.a && (p.disabled = k.a = v), k;
                  }, {
                    e: void 0,
                    t: void 0,
                    a: void 0
                  }), w;
                })();
              }
            });
          }
        });
      }
    })), l;
  })()];
};
oe(["click"]);
var Kr = /* @__PURE__ */ d('<svg><circle cx=8 cy=8 r=6 data-slot=loader-v2-background stroke-width=2></circle><circle cx=8 cy=8 r=6 data-slot=loader-v2-progress pathLength=100 stroke-width=2 stroke-dasharray="33 67">');
function ne(e) {
  const [t, n] = q(e, ["class", "classList", "width", "height"]);
  return (() => {
    var s = Kr();
    return Me(s, W(n, {
      get class() {
        return t.class;
      },
      get classList() {
        return t.classList;
      },
      get width() {
        return t.width ?? 16;
      },
      get height() {
        return t.height ?? 16;
      },
      viewBox: "0 0 16 16",
      fill: "none",
      xmlns: "http://www.w3.org/2000/svg",
      "data-component": "loader-v2",
      get "aria-hidden"() {
        return n["aria-hidden"] ?? "true";
      }
    }), !0, !0), s;
  })();
}
var Hr = /* @__PURE__ */ d("<div data-slot=radio-v2-items>"), Yr = /* @__PURE__ */ d("<div data-slot=radio-v2-item-control-stack>"), Jr = /* @__PURE__ */ d("<div data-slot=radio-v2-item-text><span data-slot=radio-v2-item-label-text>"), Qr = /* @__PURE__ */ d("<span data-slot=radio-v2-item-description>");
function Le(e) {
  const [t, n] = q(e, ["class", "classList", "children", "label", "description", "hideLabel"]);
  return r(N, W(n, {
    "data-component": "radio-v2",
    get classList() {
      return {
        ...t.classList,
        [t.class ?? ""]: !!t.class
      };
    },
    get children() {
      return [r(f, {
        get when() {
          return t.label;
        },
        children: (s) => r(N.Label, {
          "data-slot": "radio-v2-label",
          get classList() {
            return {
              "sr-only": t.hideLabel
            };
          },
          get children() {
            return s();
          }
        })
      }), r(f, {
        get when() {
          return t.description;
        },
        children: (s) => r(N.Description, {
          "data-slot": "radio-v2-description",
          get children() {
            return s();
          }
        })
      }), (() => {
        var s = Hr();
        return a(s, () => t.children), s;
      })(), r(N.ErrorMessage, {
        "data-slot": "radio-v2-error"
      })];
    }
  }));
}
function Ee(e) {
  const [t, n] = q(e, ["class", "classList", "label", "description", "hideLabel"]);
  return r(N.Item, W(n, {
    "data-slot": "radio-v2-item",
    get classList() {
      return {
        ...t.classList,
        [t.class ?? ""]: !!t.class
      };
    },
    get children() {
      return [r(N.ItemInput, {
        "data-slot": "radio-v2-item-input"
      }), (() => {
        var s = Yr();
        return a(s, r(N.ItemControl, {
          "data-slot": "radio-v2-item-control",
          get children() {
            return r(N.ItemIndicator, {
              "data-slot": "radio-v2-item-indicator"
            });
          }
        })), s;
      })(), r(N.ItemLabel, {
        "data-slot": "radio-v2-item-label",
        get classList() {
          return {
            "sr-only": t.hideLabel
          };
        },
        get children() {
          var s = Jr(), i = s.firstChild;
          return a(i, () => t.label), a(s, r(f, {
            get when() {
              return t.description;
            },
            children: (c) => (() => {
              var l = Qr();
              return a(l, c), l;
            })()
          }), null), s;
        }
      })];
    }
  }));
}
function Ae(e) {
  return /^docker-desktop(?:-data)?$/i.test(e);
}
const Xr = (e) => e.kind === "failed" || e.kind === "stopped";
function en(e) {
  if (e) {
    if (!e.resolvedPath) return "wsl.onboarding.installOpencode";
    if (e.matchesDesktop === !1) return "wsl.onboarding.updateOpencode";
  }
}
function ye(e, t) {
  const n = e?.installed.find((i) => i.name === t), s = e?.distroProbes[t];
  return !s || !n || n.version === 1 ? !1 : s.canExecute && s.hasBash && s.hasCurl;
}
function tn(e) {
  const t = e.state, n = (t?.installed ?? []).filter((p) => !Ae(p.name)), s = (t?.online ?? []).filter((p) => !Ae(p.name)), i = new Set((t?.servers ?? []).map((p) => p.config.distro)), c = n.filter((p) => !i.has(p.name)), l = rn(e.selectedDistro, n, c), o = l ? t?.opencodeChecks[l] ?? null : null, b = cn(n, s), $ = dn(b, e.catalogSearch), w = gn(e.catalogTarget, $);
  return {
    busy: !!t?.job || e.adding || e.probingAddable,
    runtimeState: nn(t),
    visibleInstalledDistros: n,
    visibleOnlineDistros: s,
    addableInstalledDistros: c,
    selectedDistro: l,
    opencodeCheck: o,
    wslReady: !!t?.runtime?.available && !t?.pendingRestart,
    distroStatuses: Object.fromEntries(
      c.flatMap((p) => {
        const _ = sn({ state: t, name: p.name, probingAddable: e.probingAddable });
        return _ ? [[p.name, _]] : [];
      })
    ),
    primaryButton: an({
      state: t,
      selectedDistro: l,
      opencodeCheck: o,
      adding: e.adding,
      probingAddable: e.probingAddable
    }),
    installableDistros: b,
    filteredInstallableDistros: $,
    catalogTarget: w,
    installingCatalogDistro: t?.job?.kind === "install-distro"
  };
}
function rn(e, t, n) {
  if (e && n.some((i) => i.name === e && i.version !== 1)) return e;
  const s = t.find((i) => i.isDefault);
  return s && s.version !== 1 && n.some((i) => i.name === s.name) ? s.name : n.find((i) => i.version !== 1)?.name ?? null;
}
function nn(e) {
  return e ? e.pendingRestart ? "pendingRestart" : e.runtime ? e.runtime.available ? "ready" : "unavailable" : "checking" : "loading";
}
function sn(e) {
  const t = e.state?.installed.find((c) => c.name === e.name);
  if (t?.version === 1) return { label: { key: "wsl.onboarding.distroStatus.unsupported" }, tone: "muted" };
  const n = e.state?.job, s = e.state?.distroProbes[e.name];
  if (!s)
    return e.probingAddable || n?.kind === "probe-addable" && n.distros.includes(e.name) ? Oe() : void 0;
  if (!s.canExecute)
    return t ? { label: { key: "wsl.onboarding.openDistroOnce", params: { distro: e.name } }, tone: "warning" } : { label: { key: "wsl.onboarding.distroNotInstalled", params: { distro: e.name } }, tone: "warning" };
  if (!s.hasBash || !s.hasCurl)
    return { label: { key: "wsl.onboarding.distroStatus.missingTools" }, tone: "warning" };
  const i = e.state?.opencodeChecks[e.name];
  return i ? i.matchesDesktop === !1 ? { label: { key: "wsl.onboarding.updateOpencode" }, tone: "warning" } : i.resolvedPath ? i.error ? { label: { key: "wsl.onboarding.installOpencode" }, tone: "warning" } : { label: { key: "wsl.onboarding.distroStatus.ready" }, tone: "success" } : { label: { key: "wsl.onboarding.distroStatus.opencodeMissing" }, tone: "warning" } : e.probingAddable || n?.kind === "probe-addable" && n.distros.includes(e.name) ? Oe() : void 0;
}
function Oe() {
  return { label: { key: "wsl.onboarding.distroStatus.checking" }, tone: "muted" };
}
function an(e) {
  const t = !!e.selectedDistro && ye(e.state, e.selectedDistro), n = e.probingAddable && !on(e.state, e.selectedDistro), s = n || t && (!e.opencodeCheck || !!e.selectedDistro && e.state?.job?.kind === "probe-addable" && e.state.job.distros.includes(e.selectedDistro)), i = e.state?.job?.kind === "install-opencode" && e.state.job.distro === e.selectedDistro;
  if (!t || s)
    return {
      variant: "contrast",
      label: n ? { key: "wsl.onboarding.distroStatus.checking" } : { key: "wsl.server.add" },
      disabled: !0,
      action: null,
      loading: n,
      width: null
    };
  if (!ln(e.opencodeCheck)) {
    const c = !!e.opencodeCheck?.resolvedPath && e.opencodeCheck.matchesDesktop === !1;
    return {
      variant: "neutral",
      label: i ? { key: "wsl.onboarding.updatingOpencode" } : c ? { key: "wsl.onboarding.updateOpencode" } : { key: "wsl.onboarding.installOpencode" },
      disabled: !!e.state?.job || e.adding,
      action: "install-opencode",
      loading: i,
      width: c ? "138px" : "129px"
    };
  }
  return {
    variant: "contrast",
    label: e.adding ? { key: "wsl.onboarding.adding" } : { key: "wsl.server.add" },
    disabled: e.adding || !!e.state?.job,
    action: "add",
    loading: e.adding,
    width: null
  };
}
function ln(e) {
  return !!e?.resolvedPath && e.matchesDesktop !== !1 && !e.error;
}
function on(e, t) {
  return !t || e?.installed.find((s) => s.name === t)?.version === 1 || !e?.distroProbes[t] ? !1 : ye(e, t) ? !!e.opencodeChecks[t] : !0;
}
function cn(e, t) {
  const n = new Set(e.map((i) => i.name)), s = t.some((i) => /^Ubuntu-\d/.test(i.name));
  return t.filter((i) => !n.has(i.name)).filter((i) => i.name !== "Ubuntu" || !s);
}
function dn(e, t) {
  const n = t.trim();
  return n ? _e.go(n, e, { keys: ["label", "name"] }).map((s) => s.obj) : e;
}
function gn(e, t) {
  return e && t.some((n) => n.name === e) ? e : t[0]?.name ?? null;
}
function un(e) {
  const t = e.state;
  if (!t?.runtime?.available || t.pendingRestart || e.view !== "main" || e.adding || t.job) return;
  const n = e.selectedDistro ? [
    ...e.addableInstalledDistros.filter((i) => i.name === e.selectedDistro),
    ...e.addableInstalledDistros.filter((i) => i.name !== e.selectedDistro)
  ] : e.addableInstalledDistros, s = n.flatMap((i) => i.version === 1 ? [] : t.distroProbes[i.name] ? ye(t, i.name) && !t.opencodeChecks[i.name] ? [`opencode:${i.name}`] : [] : [`distro:${i.name}`]);
  if (s.length)
    return {
      key: s.join("|"),
      distros: n.filter((i) => i.version !== 1).map((i) => i.name)
    };
}
function vn(e) {
  if (!(!e.state || e.busy || e.state.pendingRestart)) {
    if (!e.state.runtime) return { key: "runtime", action: "probeRuntime" };
    if (e.state.runtime.available && !(e.state.installed.length || e.state.online.length))
      return { key: "distros", action: "refreshDistros" };
  }
}
function hn(e) {
  const t = vn({ state: e.state, busy: e.busy });
  if (t) return { kind: "auto", key: `auto:${t.key}`, plan: t };
  const n = un(e);
  if (n) return { kind: "addable", key: `addable:${n.key}`, plan: n };
}
function pn() {
  let e;
  return {
    accepts(t) {
      return t !== e;
    },
    settle(t, n) {
      n && (e = t);
    },
    reset() {
      e = void 0;
    }
  };
}
async function mn(e) {
  await e.api.probeAddable(e.plan.distros);
}
function fn(e) {
  const t = pn(), n = Ne(() => ({
    mutationFn: async (s) => {
      if (s.kind === "addable") {
        await mn({ plan: s.plan, api: e.api });
        return;
      }
      s.plan.action === "probeRuntime" && await e.api.probeRuntime(), s.plan.action === "refreshDistros" && await e.api.refreshDistros();
    },
    onError: e.onError,
    onSettled: (s, i, c) => {
      c && t.settle(c.key, i);
    }
  }));
  return pt(() => {
    if (n.isPending) return;
    const s = hn({
      state: e.state(),
      view: e.view(),
      adding: e.adding(),
      busy: e.busy(),
      selectedDistro: e.selectedDistro(),
      addableInstalledDistros: e.addableInstalledDistros()
    });
    !s || !t.accepts(s.key) || n.mutate(s);
  }), {
    probingAddable: () => n.isPending && n.variables?.kind === "addable",
    resetProbeFailure: () => t.reset()
  };
}
var bn = /* @__PURE__ */ d("<div class=settings-v2-wsl-section-header><span class=settings-v2-wsl-section-title>"), wn = /* @__PURE__ */ d("<div class=settings-v2-wsl-distro-list>"), $n = /* @__PURE__ */ d('<button type=button class=settings-v2-wsl-catalog-card><span class=settings-v2-wsl-catalog-icon aria-hidden=true><svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg><path d="M13.5564 10.4443V13.5554H4.22309C3.24087 13.5554 2.44531 13.5554 2.44531 13.5554V10.4443M11.112 5.99989L8.00087 9.111L4.88976 5.99989M8.00087 9.111L8.00087 2.44434"stroke=currentColor></path></svg></span><span class=settings-v2-wsl-catalog-copy><span class=settings-v2-wsl-catalog-title></span><span class=settings-v2-wsl-catalog-description></span></span><span class=settings-v2-wsl-catalog-chevron aria-hidden=true><svg width=16 height=16 viewBox="0 0 16 16"fill=none xmlns=http://www.w3.org/2000/svg><path d="M6 12L10 8L6 4"stroke=currentColor>'), ve = /* @__PURE__ */ d("<div class=settings-v2-wsl-loading>"), _n = /* @__PURE__ */ d("<div class=settings-v2-wsl-catalog-list>"), Re = /* @__PURE__ */ d("<span class=settings-v2-wsl-distro-label>"), Sn = /* @__PURE__ */ d("<div class=settings-v2-wsl-distro-list><div class=settings-v2-wsl-distro-empty>"), yn = /* @__PURE__ */ d("<span class=settings-v2-wsl-distro-status>"), Cn = /* @__PURE__ */ d("<p class=settings-v2-wsl-unavailable-error>"), kn = /* @__PURE__ */ d('<div class=settings-v2-wsl-not-installed-content><div class=settings-v2-wsl-not-installed-message><svg class=settings-v2-wsl-not-installed-icon width=24 height=24 viewBox="0 0 24 24"fill=none xmlns=http://www.w3.org/2000/svg aria-hidden=true><g clip-path=url(#settings-v2-wsl-warning-clip)><path fill-rule=evenodd clip-rule=evenodd d="M12 -0.00244141L23.6926 20.2498H0.308594L12 -0.00244141ZM12.7954 6.32932C12.5844 6.11834 12.2982 5.99982 11.9999 5.99982C11.7015 5.99982 11.4154 6.11834 11.2044 6.32932C10.9934 6.5403 10.8749 6.82645 10.8749 7.12482V11.6248C10.8749 11.9232 10.9934 12.2093 11.2044 12.4203C11.4154 12.6313 11.7015 12.7498 11.9999 12.7498C12.2982 12.7498 12.5844 12.6313 12.7954 12.4203C13.0064 12.2093 13.1249 11.9232 13.1249 11.6248V7.12482C13.1249 6.82645 13.0064 6.5403 12.7954 6.32932ZM13.0605 17.5605C12.7792 17.8418 12.3977 17.9998 11.9999 17.9998C11.6021 17.9998 11.2205 17.8418 10.9392 17.5605C10.6579 17.2792 10.4999 16.8976 10.4999 16.4998C10.4999 16.102 10.6579 15.7205 10.9392 15.4392C11.2205 15.1579 11.6021 14.9998 11.9999 14.9998C12.3977 14.9998 12.7792 15.1579 13.0605 15.4392C13.3418 15.7205 13.4999 16.102 13.4999 16.4998C13.4999 16.8976 13.3418 17.2792 13.0605 17.5605Z"fill=#DBDBDB></path></g><defs><clipPath id=settings-v2-wsl-warning-clip><rect width=24 height=24 fill=white></rect></clipPath></defs></svg><h2 class=settings-v2-wsl-not-installed-title></h2><p class=settings-v2-wsl-not-installed-description>');
function Dn(e) {
  return e ? /WSL is not installed|not been installed|wsl(?:\.exe)? --install/i.test(e) : !0;
}
function Ve(e, t) {
  return t.params ? e.t(t.key, t.params) : e.t(t.key);
}
function xn(e = {}) {
  const t = O(), n = In(e), s = n.model, i = () => s().primaryButton, c = () => {
    const l = i().width;
    if (l)
      return {
        width: l
      };
  };
  return r(f, {
    get when() {
      return P(() => !n.wslServers.isPending)() && !n.wslServers.isError;
    },
    get fallback() {
      return r(X, {
        fit: !0,
        class: "settings-v2-wsl-dialog",
        get children() {
          return r(f, {
            get when() {
              return !n.wslServers.isError;
            },
            get fallback() {
              return (() => {
                var l = ve();
                return a(l, () => n.loadError()), l;
              })();
            },
            get children() {
              var l = ve();
              return a(l, r(ne, {})), l;
            }
          });
        }
      });
    },
    get children() {
      return r(f, {
        get when() {
          return s().runtimeState === "ready";
        },
        get fallback() {
          return r(f, {
            get when() {
              return s().runtimeState === "checking" || s().runtimeState === "loading";
            },
            get fallback() {
              return r(Pn, {
                get state() {
                  return s().runtimeState;
                },
                get error() {
                  return n.runtimeError();
                },
                get installable() {
                  return Dn(n.runtimeError());
                },
                get busy() {
                  return s().busy;
                },
                get onInstall() {
                  return n.installWsl;
                }
              });
            },
            get children() {
              return r(X, {
                fit: !0,
                class: "settings-v2-wsl-dialog",
                get children() {
                  var l = ve();
                  return a(l, r(ne, {})), l;
                }
              });
            }
          });
        },
        get children() {
          return r(X, {
            fit: !0,
            class: "settings-v2-wsl-dialog",
            get children() {
              return [r(mt, {
                hideClose: !0,
                get children() {
                  return r(ft, {
                    get children() {
                      return P(() => n.view() === "main")() ? t.t("wsl.server.add") : t.t("wsl.onboarding.installDistro");
                    }
                  });
                }
              }), r(bt, {}), r(f, {
                get when() {
                  return n.view() === "main";
                },
                get fallback() {
                  return [r(ke, {
                    class: "settings-v2-wsl-dialog-body settings-v2-wsl-catalog-picker",
                    get children() {
                      return [r(de, {
                        class: "settings-v2-wsl-catalog-search",
                        appearance: "large",
                        get placeholder() {
                          return t.t("wsl.onboarding.searchDistros");
                        },
                        get value() {
                          return n.catalogSearch();
                        },
                        get disabled() {
                          return s().busy;
                        },
                        onInput: (l) => n.setCatalogSearch(l.currentTarget.value)
                      }), (() => {
                        var l = _n();
                        return a(l, r(Le, {
                          hideLabel: !0,
                          class: "settings-v2-wsl-distro-group",
                          get label() {
                            return t.t("wsl.onboarding.installDistro");
                          },
                          get value() {
                            return s().catalogTarget ?? void 0;
                          },
                          get onChange() {
                            return n.setCatalogTarget;
                          },
                          get disabled() {
                            return s().busy;
                          },
                          get children() {
                            return r(z, {
                              get each() {
                                return s().filteredInstallableDistros;
                              },
                              children: (o) => r(Ee, {
                                class: "settings-v2-wsl-distro-row settings-v2-wsl-catalog-row",
                                get value() {
                                  return o.name;
                                },
                                get disabled() {
                                  return s().busy;
                                },
                                get label() {
                                  return (() => {
                                    var b = Re();
                                    return a(b, () => o.label), b;
                                  })();
                                }
                              })
                            });
                          }
                        })), l;
                      })()];
                    }
                  }), r(De, {
                    get children() {
                      return [r(V, {
                        variant: "neutral",
                        get disabled() {
                          return s().busy;
                        },
                        get onClick() {
                          return n.closeCatalog;
                        },
                        get children() {
                          return t.t("common.cancel");
                        }
                      }), r(V, {
                        get variant() {
                          return s().installingCatalogDistro ? "loading" : "contrast";
                        },
                        get disabled() {
                          return P(() => !s().installingCatalogDistro)() && (s().busy || !s().catalogTarget);
                        },
                        style: {
                          width: "99px"
                        },
                        get onClick() {
                          return n.installCatalogDistro;
                        },
                        get children() {
                          return r(f, {
                            get when() {
                              return s().installingCatalogDistro;
                            },
                            get fallback() {
                              return t.t("wsl.onboarding.installDistro");
                            },
                            get children() {
                              return r(ne, {});
                            }
                          });
                        }
                      })];
                    }
                  })];
                },
                get children() {
                  return [r(ke, {
                    class: "settings-v2-wsl-dialog-body",
                    get children() {
                      return [(() => {
                        var l = bn(), o = l.firstChild;
                        return a(o, () => t.t("wsl.onboarding.installedDistros")), a(l, r(V, {
                          variant: "ghost-muted",
                          size: "small",
                          get disabled() {
                            return s().busy;
                          },
                          get onClick() {
                            return n.refreshDistros;
                          },
                          get children() {
                            return t.t("wsl.onboarding.checkAgain");
                          }
                        }), null), l;
                      })(), r(f, {
                        get when() {
                          return s().addableInstalledDistros.length > 0;
                        },
                        get fallback() {
                          return (() => {
                            var l = Sn(), o = l.firstChild;
                            return a(o, (() => {
                              var b = P(() => !!s().visibleInstalledDistros.length);
                              return () => b() ? t.t("wsl.onboarding.allDistrosAdded") : t.t("wsl.onboarding.noDistros");
                            })()), l;
                          })();
                        },
                        get children() {
                          var l = wn();
                          return a(l, r(Le, {
                            hideLabel: !0,
                            class: "settings-v2-wsl-distro-group",
                            get label() {
                              return t.t("wsl.onboarding.installedDistros");
                            },
                            get value() {
                              return s().selectedDistro ?? void 0;
                            },
                            get onChange() {
                              return n.setSelectedDistro;
                            },
                            get disabled() {
                              return s().busy;
                            },
                            get children() {
                              return r(z, {
                                get each() {
                                  return s().addableInstalledDistros;
                                },
                                children: (o) => {
                                  const b = () => s().distroStatuses[o.name] ?? null;
                                  return r(Ee, {
                                    get class() {
                                      return `settings-v2-wsl-distro-row${o.version === 1 ? " settings-v2-wsl-distro-row--unsupported" : ""}`;
                                    },
                                    get value() {
                                      return o.name;
                                    },
                                    get disabled() {
                                      return o.version === 1 || s().busy;
                                    },
                                    get label() {
                                      return (() => {
                                        var $ = Re();
                                        return a($, () => o.name), $;
                                      })();
                                    },
                                    get description() {
                                      return r(f, {
                                        get when() {
                                          return b();
                                        },
                                        children: ($) => (() => {
                                          var w = yn();
                                          return a(w, () => Ve(t, $().label)), ee(() => ie(w, "data-tone", $().tone)), w;
                                        })()
                                      });
                                    }
                                  });
                                }
                              });
                            }
                          })), l;
                        }
                      }), r(f, {
                        get when() {
                          return s().installableDistros.length > 0;
                        },
                        get children() {
                          var l = $n(), o = l.firstChild, b = o.nextSibling, $ = b.firstChild, w = $.nextSibling;
                          return wt(l, "click", n.openCatalog, !0), a($, () => t.t("wsl.onboarding.needAnotherDistro")), a(w, () => t.t("wsl.onboarding.needAnotherDistroHint")), ee(() => l.disabled = s().busy), l;
                        }
                      })];
                    }
                  }), r(De, {
                    get children() {
                      return [r(V, {
                        variant: "neutral",
                        get disabled() {
                          return n.adding();
                        },
                        get onClick() {
                          return n.close;
                        },
                        get children() {
                          return t.t("common.cancel");
                        }
                      }), r(V, {
                        get variant() {
                          return P(() => !!i().loading)() ? "loading" : i().variant;
                        },
                        get disabled() {
                          return P(() => !i().loading)() && i().disabled;
                        },
                        get style() {
                          return c();
                        },
                        get onClick() {
                          return n.runPrimary;
                        },
                        get children() {
                          return r(f, {
                            get when() {
                              return i().loading;
                            },
                            get fallback() {
                              return Ve(t, i().label);
                            },
                            get children() {
                              return r(ne, {});
                            }
                          });
                        }
                      })];
                    }
                  })];
                }
              })];
            }
          });
        }
      });
    }
  });
}
function In(e) {
  const t = O(), n = re(), s = Z(), i = Se(), c = n.wslServers, [l, o] = be({
    view: "main",
    selectedDistro: null,
    catalogSearch: "",
    catalogTarget: null,
    adding: !1
  }), b = () => i.data, $ = (S) => tn({
    state: b(),
    view: l.view,
    selectedDistro: l.selectedDistro,
    catalogSearch: l.catalogSearch,
    catalogTarget: l.catalogTarget,
    adding: l.adding,
    probingAddable: S
  }), w = E(() => $(!1)), u = fn({
    state: b,
    api: c,
    view: () => l.view,
    adding: () => l.adding,
    busy: () => w().busy,
    selectedDistro: () => w().selectedDistro,
    addableInstalledDistros: () => w().addableInstalledDistros,
    onError: (S) => he(t, S)
  }), p = E(() => $(u.probingAddable())), _ = () => {
    const S = p().installableDistros[0];
    o({
      view: "catalog",
      catalogSearch: "",
      catalogTarget: S?.name ?? null
    });
  }, x = async (S) => {
    try {
      await S();
    } catch (h) {
      he(t, h);
    }
  }, T = () => {
    x(async () => {
      u.resetProbeFailure(), await c.refreshDistros();
    });
  }, k = (S) => {
    x(async () => {
      u.resetProbeFailure(), await c.installDistro(S), o("view", "main");
    });
  }, L = () => {
    if (p().installingCatalogDistro) return;
    const S = p().catalogTarget;
    S && k(S);
  }, m = () => {
    u.resetProbeFailure(), o({
      view: "main",
      catalogSearch: "",
      catalogTarget: null
    });
  }, v = async () => {
    const S = p().primaryButton;
    if (S.loading) return;
    const h = p().selectedDistro, y = S.action;
    if (!(!h || !y)) {
      if (y === "install-opencode") {
        await x(() => c.installOpencode(h));
        return;
      }
      o("adding", !0);
      try {
        await c.addServer(h), e.onAdded ? await e.onAdded(h) : s.close();
      } catch (g) {
        he(t, g);
      } finally {
        o("adding", !1);
      }
    }
  };
  return {
    wslServers: i,
    model: p,
    loadError: () => {
      const S = i.error;
      return S ? S instanceof Error ? S.message : String(S) : t.t("wsl.onboarding.loadFailed");
    },
    runtimeError: () => b()?.runtime?.error ?? null,
    view: () => l.view,
    catalogSearch: () => l.catalogSearch,
    adding: () => l.adding,
    setCatalogSearch: (S) => o("catalogSearch", S),
    setCatalogTarget: (S) => o("catalogTarget", S),
    setSelectedDistro: (S) => o("selectedDistro", S),
    openCatalog: _,
    closeCatalog: m,
    refreshDistros: T,
    installCatalogDistro: L,
    installWsl: () => void x(() => c.installWsl()),
    runPrimary: () => void v(),
    close: () => s.close()
  };
}
function Pn(e) {
  const t = O(), n = Z(), s = () => e.state === "pendingRestart" ? t.t("wsl.onboarding.restartRequired") : e.installable ? t.t("wsl.onboarding.wslNotInstalled.title") : t.t("wsl.onboarding.wslUnavailable.title"), i = () => e.state === "pendingRestart" ? t.t("wsl.onboarding.windowsRestartRequired") : e.installable ? t.t("wsl.onboarding.wslNotInstalled.description") : t.t("wsl.onboarding.wslUnavailable.description");
  return r(X, {
    fit: !0,
    class: "settings-v2-wsl-not-installed-dialog",
    get children() {
      var c = kn(), l = c.firstChild, o = l.firstChild, b = o.nextSibling, $ = b.nextSibling;
      return a(b, s), a($, i), a(l, r(f, {
        get when() {
          return P(() => !e.installable)() && e.error;
        },
        get children() {
          var w = Cn();
          return a(w, () => e.error), w;
        }
      }), null), a(c, r(f, {
        get when() {
          return P(() => e.state === "unavailable")() && e.installable;
        },
        get children() {
          return r(V, {
            variant: "neutral",
            get disabled() {
              return e.busy;
            },
            get onClick() {
              return e.onInstall;
            },
            get children() {
              return t.t("wsl.onboarding.installWsl");
            }
          });
        }
      }), null), a(c, r(f, {
        get when() {
          return e.state !== "unavailable";
        },
        get children() {
          return r(V, {
            variant: "neutral",
            onClick: () => n.close(),
            get children() {
              return t.t("common.close");
            }
          });
        }
      }), null), c;
    }
  });
}
function he(e, t) {
  console.error("WSL servers request failed", t instanceof Error ? t.stack ?? t.message : String(t)), $t({
    variant: "error",
    title: e.t("common.requestFailed"),
    description: t instanceof Error ? t.message : String(t)
  });
}
oe(["click"]);
var Tn = /* @__PURE__ */ d('<div class=settings-v2-servers-row><div class=settings-v2-servers-lead><div class=settings-v2-servers-copy><span class="flex min-w-0 items-center gap-1"><span class=settings-v2-servers-name></span><span class="shrink-0 rounded-[3px] border border-v2-border-border-base px-1 py-0.5 text-[9px] leading-none text-v2-text-text-muted"></span></span><span class=settings-v2-servers-meta></span></div></div><div class=settings-v2-servers-actions>');
function Fe(e) {
  return e.type === "sidecar" && e.variant === "wsl";
}
function Ln(e) {
  const t = re(), n = Z(), s = O(), i = () => {
    n.push(() => r(xn, {}));
  };
  return r(f, {
    get when() {
      return t.wslServers;
    },
    get fallback() {
      return r(V, {
        variant: "ghost-muted",
        icon: "plus",
        get onClick() {
          return e.onAddServer;
        },
        get children() {
          return s.t("dialog.server.add.button");
        }
      });
    },
    get children() {
      return r(A, {
        gutter: 4,
        modal: !1,
        placement: "bottom-end",
        get children() {
          return [r(A.Trigger, {
            as: V,
            variant: "ghost-muted",
            icon: "plus",
            get children() {
              return s.t("dialog.server.add.button");
            }
          }), r(A.Portal, {
            get children() {
              return r(A.Content, {
                get children() {
                  return [r(A.Item, {
                    get onSelect() {
                      return e.onAddServer;
                    },
                    get children() {
                      return s.t("dialog.server.add.button");
                    }
                  }), r(A.Item, {
                    onSelect: i,
                    get children() {
                      return s.t("wsl.server.add");
                    }
                  })];
                }
              });
            }
          })];
        }
      });
    }
  });
}
function En(e) {
  const t = Se();
  return E(() => {
    const n = t.data?.servers ?? [], s = e().trim();
    return s ? _e.go(s, n, {
      keys: [(i) => i.config.distro, (i) => i.config.id]
    }).map((i) => i.obj) : n;
  });
}
function An(e) {
  const t = re(), n = O(), s = Se(), i = t.wslServers, c = Ne(() => ({
    mutationFn: (o) => o(),
    onError: (o) => Q({
      variant: "error",
      title: n.t("common.requestFailed"),
      description: o instanceof Error ? o.message : String(o)
    })
  })), l = (o) => {
    c.mutate(() => e.controller.handleRemove(o));
  };
  return r(f, {
    when: i,
    get children() {
      return r(z, {
        get each() {
          return e.servers();
        },
        children: (o) => {
          const b = je.Key.make(o.config.id), $ = () => s.data?.opencodeChecks[o.config.distro], w = () => en($()), u = () => s.data?.job?.kind === "install-opencode" && s.data.job.distro === o.config.distro;
          return (() => {
            var p = Tn(), _ = p.firstChild, x = _.firstChild, T = x.firstChild, k = T.firstChild, L = k.nextSibling, m = T.nextSibling, v = _.nextSibling;
            return a(_, r(ze, {
              get health() {
                return e.controller.status()[b];
              }
            }), x), a(k, () => o.config.distro), a(L, () => n.t("wsl.server.label")), a(m, r(f, {
              get when() {
                return $()?.version;
              },
              children: (C) => `v${C()}`
            })), a(v, r(f, {
              get when() {
                return P(() => !!e.controller.canDefault())() && e.controller.defaultKey() === b;
              },
              get children() {
                return r(Y, {
                  get children() {
                    return n.t("dialog.server.status.default");
                  }
                });
              }
            }), null), a(v, r(f, {
              get when() {
                return w();
              },
              children: (C) => r(V, {
                size: "small",
                get disabled() {
                  return u() || c.isPending;
                },
                onClick: () => i && c.mutate(() => i.installOpencode(o.config.distro)),
                get children() {
                  return P(() => !!u())() ? n.t("wsl.server.updating") : n.t(C());
                }
              })
            }), null), a(v, r(A, {
              gutter: 4,
              modal: !1,
              placement: "bottom-end",
              get children() {
                return [r(A.Trigger, {
                  as: we,
                  variant: "ghost-muted",
                  size: "small",
                  get icon() {
                    return r($e, {
                      name: "outline-dots"
                    });
                  },
                  get "aria-label"() {
                    return n.t("common.moreOptions");
                  }
                }), r(A.Portal, {
                  get children() {
                    return r(A.Content, {
                      get children() {
                        return r(A.Group, {
                          get children() {
                            return [r(A.GroupLabel, {
                              get children() {
                                return n.t("wsl.server.menu.label");
                              }
                            }), r(f, {
                              get when() {
                                return Xr(o.runtime);
                              },
                              get children() {
                                return r(A.Item, {
                                  onSelect: () => i && c.mutate(() => i.startServer(b)),
                                  get children() {
                                    return n.t("wsl.server.retryStart");
                                  }
                                });
                              }
                            }), r(f, {
                              get when() {
                                return P(() => !!e.controller.canDefault())() && e.controller.defaultKey() !== b;
                              },
                              get children() {
                                return r(A.Item, {
                                  onSelect: () => e.controller.setDefault(b),
                                  get children() {
                                    return n.t("dialog.server.menu.default");
                                  }
                                });
                              }
                            }), r(f, {
                              get when() {
                                return P(() => !!e.controller.canDefault())() && e.controller.defaultKey() === b;
                              },
                              get children() {
                                return r(A.Item, {
                                  onSelect: () => e.controller.setDefault(null),
                                  get children() {
                                    return n.t("dialog.server.menu.defaultRemove");
                                  }
                                });
                              }
                            }), r(A.Separator, {}), r(A.Item, {
                              onSelect: () => l(b),
                              get children() {
                                return n.t("dialog.server.menu.delete");
                              }
                            })];
                          }
                        });
                      }
                    });
                  }
                })];
              }
            }), null), p;
          })();
        }
      });
    }
  });
}
var On = /* @__PURE__ */ d("<div class=settings-v2-tab-search>"), Rn = /* @__PURE__ */ d('<div class="settings-v2-tab-header settings-v2-servers-header"><div class=settings-v2-tab-header-row><h2 class=settings-v2-tab-title>'), Vn = /* @__PURE__ */ d('<div class="settings-v2-tab-body settings-v2-servers">'), Fn = /* @__PURE__ */ d("<span class=settings-v2-servers-status-filter>&quot;<!>&quot;"), Mn = /* @__PURE__ */ d("<div class=settings-v2-servers-status><span>"), Bn = /* @__PURE__ */ d("<div class=settings-v2-servers-row><div class=settings-v2-servers-lead><div class=settings-v2-servers-copy><span class=settings-v2-servers-name></span><span class=settings-v2-servers-meta></span></div></div><div class=settings-v2-servers-actions>");
const Nn = () => {
  const e = Z(), t = O(), n = _t(), [s, i] = be({
    filter: ""
  }), c = En(() => s.filter), l = E(() => n.sortedItems().filter((w) => !Fe(w)).length + c().length > 1), o = E(() => {
    const w = n.sortedItems().filter((p) => !Fe(p)), u = s.filter.trim();
    return u ? _e.go(u, w, {
      keys: [(p) => xe(p), (p) => p.http.url]
    }).map((p) => p.obj) : w;
  }), b = () => {
    e.push(() => r(Ie, {
      mode: "add"
    }));
  }, $ = (w) => {
    e.push(() => r(Ie, {
      mode: "edit",
      server: w
    }));
  };
  return [(() => {
    var w = Rn(), u = w.firstChild, p = u.firstChild;
    return a(p, () => t.t("status.popover.tab.servers")), a(u, r(Ln, {
      onAddServer: b
    }), null), a(w, r(f, {
      get when() {
        return l();
      },
      get children() {
        var _ = On();
        return a(_, r(de, {
          type: "search",
          appearance: "base",
          get value() {
            return s.filter;
          },
          onInput: (x) => i("filter", x.currentTarget.value),
          get placeholder() {
            return t.t("dialog.server.search.placeholder");
          },
          spellcheck: !1,
          autocorrect: "off",
          autocomplete: "off",
          autocapitalize: "off",
          get "aria-label"() {
            return t.t("dialog.server.search.placeholder");
          }
        }), null), a(_, r(f, {
          get when() {
            return s.filter;
          },
          get children() {
            return r(we, {
              type: "button",
              variant: "ghost-muted",
              size: "small",
              class: "settings-v2-tab-search-clear",
              get icon() {
                return r($e, {
                  name: "close",
                  size: "large",
                  class: "text-v2-icon-icon-muted"
                });
              },
              onClick: () => i("filter", "")
            });
          }
        }), null), _;
      }
    }), null), ee(() => w.classList.toggle("settings-v2-tab-header--stacked", !!l())), w;
  })(), (() => {
    var w = Vn();
    return a(w, r(f, {
      get when() {
        return o().length > 0 || c().length > 0;
      },
      get fallback() {
        return (() => {
          var u = Mn(), p = u.firstChild;
          return a(p, (() => {
            var _ = P(() => !!s.filter);
            return () => _() ? t.t("palette.empty") : t.t("dialog.server.empty");
          })()), a(u, r(f, {
            get when() {
              return s.filter;
            },
            get children() {
              var _ = Fn(), x = _.firstChild, T = x.nextSibling;
              return T.nextSibling, a(_, () => s.filter, T), _;
            }
          }), null), u;
        })();
      },
      get children() {
        return r(M, {
          get children() {
            return [r(An, {
              controller: n,
              servers: c
            }), r(z, {
              get each() {
                return o();
              },
              children: (u) => {
                const p = je.key(u), _ = () => n.status()[p], x = () => n.defaultKey() === p;
                return (() => {
                  var T = Bn(), k = T.firstChild, L = k.firstChild, m = L.firstChild, v = m.nextSibling, C = k.nextSibling;
                  return a(k, r(ze, {
                    get health() {
                      return _();
                    }
                  }), L), a(m, () => xe(u)), a(v, r(f, {
                    get when() {
                      return _()?.version;
                    },
                    get children() {
                      return ["v", P(() => _()?.version)];
                    }
                  }), null), a(v, r(f, {
                    get when() {
                      return P(() => !!_()?.version)() && u.type === "http";
                    },
                    children: " • "
                  }), null), a(v, r(f, {
                    get when() {
                      return P(() => u.type === "http")() && u.http.username;
                    },
                    get fallback() {
                      return r(f, {
                        get when() {
                          return u.type === "http";
                        },
                        get children() {
                          return t.t("server.row.noUsername");
                        }
                      });
                    },
                    get children() {
                      return u.http.username;
                    }
                  }), null), a(C, r(f, {
                    get when() {
                      return P(() => !!n.canDefault())() && x();
                    },
                    get children() {
                      return r(Y, {
                        get children() {
                          return t.t("dialog.server.status.default");
                        }
                      });
                    }
                  }), null), a(C, r(St, {
                    server: u,
                    controller: n,
                    onEdit: $
                  }), null), T;
                })();
              }
            })];
          }
        });
      }
    })), w;
  })()];
};
var jn = /* @__PURE__ */ d('<div class="flex flex-col justify-between h-full w-full"><div class="flex flex-col gap-3 w-full"><div class="flex flex-col gap-3"><div class="flex flex-col gap-1.5"><div class="flex flex-col gap-1.5 w-full"></div></div><div class="flex flex-col gap-1.5"><div class="flex flex-col gap-1.5 w-full"></div></div></div></div><div class=settings-v2-nav-footer><span></span><span>v');
const zn = (e) => {
  const t = O(), n = re(), s = Z(), i = yt(), c = Ct(), l = ce(), [o, b] = kt(e.defaultValue ?? "general"), $ = E(() => {
    const u = i.route();
    if (u.type === "dir-new-sesssion") return u.dir;
    if (u.type === "draft") {
      const p = c.store.find((_) => _.type === "draft" && _.draftID === u.draftID);
      return p?.type === "draft" ? p.directory : void 0;
    }
    if (u.type === "session") return l().session.get(u.sessionId)?.directory;
  }), w = () => {
    s.show(() => r(zn, {
      get sessionID() {
        return e.sessionID;
      },
      defaultValue: "providers"
    }));
  };
  return r(X, {
    size: "x-large",
    variant: "settings",
    class: "settings-v2-dialog",
    get children() {
      return r(F, {
        orientation: "vertical",
        variant: "settings",
        get value() {
          return o();
        },
        onChange: (u) => void Dt(() => b(u)),
        class: "settings-v2",
        get children() {
          return [r(F.List, {
            get children() {
              var u = jn(), p = u.firstChild, _ = p.firstChild, x = _.firstChild, T = x.firstChild, k = x.nextSibling, L = k.firstChild, m = p.nextSibling, v = m.firstChild, C = v.nextSibling;
              return C.firstChild, a(x, r(F.SectionTitle, {
                get children() {
                  return t.t("settings.section.desktop");
                }
              }), T), a(T, r(F.Trigger, {
                value: "general",
                get children() {
                  return [r(J, {
                    name: "sliders"
                  }), P(() => t.t("settings.tab.general"))];
                }
              }), null), a(T, r(F.Trigger, {
                value: "shortcuts",
                get children() {
                  return [r(J, {
                    name: "keyboard"
                  }), P(() => t.t("settings.tab.shortcuts"))];
                }
              }), null), a(k, r(F.SectionTitle, {
                get children() {
                  return t.t("settings.section.server");
                }
              }), L), a(L, r(F.Trigger, {
                value: "servers",
                get children() {
                  return [r(J, {
                    name: "server"
                  }), P(() => t.t("status.popover.tab.servers"))];
                }
              }), null), a(L, r(F.Trigger, {
                value: "providers",
                get children() {
                  return [r(J, {
                    name: "providers"
                  }), P(() => t.t("settings.providers.title"))];
                }
              }), null), a(L, r(F.Trigger, {
                value: "models",
                get children() {
                  return [r(J, {
                    name: "models"
                  }), P(() => t.t("settings.models.title"))];
                }
              }), null), a(v, () => t.t("app.name.desktop")), a(C, () => n.version, null), u;
            }
          }), r(F.Content, {
            value: "general",
            class: "settings-v2-panel",
            get children() {
              return r(xr, {
                get sessionID() {
                  return e.sessionID;
                }
              });
            }
          }), r(F.Content, {
            value: "shortcuts",
            class: "settings-v2-panel",
            get children() {
              return r(It, {
                v2: !0
              });
            }
          }), r(F.Content, {
            value: "servers",
            class: "settings-v2-panel",
            get children() {
              return r(Nn, {});
            }
          }), r(F.Content, {
            value: "providers",
            class: "settings-v2-panel",
            get children() {
              return r(Fr, {
                directory: $,
                onBack: w
              });
            }
          }), r(F.Content, {
            value: "models",
            class: "settings-v2-panel",
            get children() {
              return r(Gr, {});
            }
          })];
        }
      });
    }
  });
};
export {
  zn as DialogSettings
};
