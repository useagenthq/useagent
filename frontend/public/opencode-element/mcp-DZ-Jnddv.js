import { cm as o, b$ as a, c3 as e, bG as c } from "./skynet-element-dDv65e_D.js";
function u() {
  const n = o(), s = a();
  return e(() => ({
    mutationFn: n().mcp.toggle,
    onError: (t) => c({
      variant: "error",
      title: s.t("common.requestFailed"),
      description: t instanceof Error ? t.message : String(t)
    })
  }));
}
export {
  u
};
