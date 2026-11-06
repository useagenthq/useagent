// Who holds a listening port inside a sandbox. An open port alone could be any
// process there (an agent's dev server, a stray listener), so a service the
// plane launched is recognised by the process that owns the socket: its
// executable and its leading arguments, read from /proc.

/** The process that must own the IPv4 socket `address:port` and the argv[1..]
 * it starts with. Its executable is either one exact file (`executablePath`,
 * compared by real path) or a file name that must resolve inside `installRoot`.
 * Only that exact socket is the service: a sandbox agent may mirror a loopback
 * listener on another address under the same port. A wildcard listener on the
 * port shadows any other address, so it counts as the port's holder too. */
export type SandboxListenerOwner = {
  readonly address: string;
  readonly port: number;
  readonly args: readonly string[];
} & (
  | { readonly executablePath: string }
  | { readonly executable: string; readonly installRoot: string }
);

/** Per-port verdict in the probe's output. */
export const LISTENER_OURS = 0;
export const LISTENER_ABSENT = 1;
export const LISTENER_FOREIGN = 2;
/** Held by our own service still running an executable a later install replaced
 *  (its /proc exe link ends in " (deleted)"): it is stopped and started again. */
export const LISTENER_STALE = 3;

export type ListenerVerdicts = Readonly<Record<number, number>>;

/**
 * One shell command that prints a JSON object of port -> verdict (0 ours,
 * 1 nothing listening, 2 held by another process, 3 ours on a replaced
 * executable) and exits 0 when every port is ours, 2 as soon as one is foreign,
 * 1 otherwise at the deadline. Polls every 50 ms until then. With `stopStale`
 * it kills each stale holder (only those) and is done once every port is ours or
 * free: a holder still exiting after its kill can read as foreign for a moment.
 * The optional trailing argument is the proc root, for tests.
 */
export function buildSandboxListenerProbeCommand(
  owners: readonly SandboxListenerOwner[],
  deadlineMs: number,
  options: { readonly stopStale?: boolean } = {},
): string {
  const script = [
    'const fs=require("node:fs"),path=require("node:path")',
    'const owners=JSON.parse(Buffer.from(process.argv[1],"base64").toString("utf8")),proc=process.argv[2]||"/proc"',
    `const deadline=Date.now()+${deadlineMs}`,
    `const stop=${options.stopStale === true}`,
    'const real=p=>{try{return fs.realpathSync(p)}catch{return null}}',
    'const socketHex=owner=>owner.address.split(".").map(Number).reverse().map(n=>n.toString(16).toUpperCase().padStart(2,"0")).join("")+":"+owner.port.toString(16).toUpperCase().padStart(4,"0")',
    'const listening=owner=>{const local=socketHex(owner),wildcard=socketHex({address:"0.0.0.0",port:owner.port}),found=new Set();let text="";try{text=fs.readFileSync(path.join(proc,"net/tcp"),"utf8")}catch{return found}for(const line of text.split("\\n").slice(1)){const c=line.trim().split(/\\s+/);if(c.length>9&&(c[1]===local||c[1]===wildcard)&&c[3]==="0A")found.add(c[9])}return found}',
    'const holds=(pid,found)=>{try{return fs.readdirSync(path.join(proc,pid,"fd")).some(fd=>{try{const link=fs.readlinkSync(path.join(proc,pid,"fd",fd));return link.startsWith("socket:[")&&found.has(link.slice(8,-1))}catch{return false}})}catch{return false}}',
    // A holder's executable by real path; once a later install unlinked that file,
    // the kernel names it "<path> (deleted)": the path it ran from, marked stale.
    'const exeOf=pid=>{const link=path.join(proc,pid,"exe");try{return{file:fs.realpathSync(link),stale:false}}catch{}try{const target=fs.readlinkSync(link);return target.endsWith(" (deleted)")?{file:target.slice(0,-" (deleted)".length),stale:true}:null}catch{return null}}',
    'const identity=(pid,owner)=>{try{const exe=exeOf(pid);if(!exe)return"foreign";const args=fs.readFileSync(path.join(proc,pid,"cmdline"),"utf8").split("\\0");if(owner.executablePath){if(real(owner.executablePath)!==exe.file)return"foreign"}else{const root=real(owner.installRoot),rel=root===null?"..":path.relative(root,exe.file);if(path.basename(exe.file)!==owner.executable||rel===""||rel.startsWith("..")||path.isAbsolute(rel))return"foreign"}return owner.args.every((arg,i)=>args[i+1]===arg)?(exe.stale?"stale":"ours"):"foreign"}catch{return"foreign"}}',
    'const verdict=owner=>{const found=listening(owner);if(found.size===0)return 1;const holders=fs.readdirSync(proc).filter(pid=>!Number.isNaN(Number(pid))&&holds(pid,found));if(holders.length===0)return 2;const ids=holders.map(pid=>identity(pid,owner));if(ids.includes("foreign"))return 2;if(!ids.includes("stale"))return 0;if(stop)holders.forEach((pid,i)=>{if(ids[i]==="stale")try{process.kill(Number(pid),"SIGKILL")}catch{}});return 3}',
    'const probe=()=>{const verdicts={};for(const owner of owners)verdicts[owner.port]=verdict(owner);const values=Object.values(verdicts);const done=Date.now()>=deadline||(stop?values.every(v=>v===0||v===1):values.every(v=>v===0)||values.includes(2));if(!done){setTimeout(probe,50);return}console.log(JSON.stringify(verdicts));process.exit(values.includes(2)?2:values.every(v=>v===0)?0:1)}',
    "probe()",
  ].join(";");
  const encoded = Buffer.from(JSON.stringify(owners), "utf8").toString("base64");
  return `node -e ${JSON.stringify(script)} ${encoded}`;
}

/** The verdicts a probe printed, or null when it printed none (the command
 * itself failed). A port missing from the output reads as absent. */
export function readListenerVerdicts(
  output: string,
  owners: readonly SandboxListenerOwner[],
): ListenerVerdicts | null {
  let parsed: Record<string, unknown> | null = null;
  for (const line of output.split(/\r?\n/).reverse()) {
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        parsed = value as Record<string, unknown>;
        break;
      }
    } catch {
      // Diagnostics around the verdict line are not part of the answer.
    }
  }
  if (!parsed) return null;
  const verdicts = parsed;
  return Object.fromEntries(owners.map(({ port }) => {
    const verdict = verdicts[String(port)];
    return [port, verdict === LISTENER_OURS || verdict === LISTENER_FOREIGN || verdict === LISTENER_STALE ? verdict : LISTENER_ABSENT];
  }));
}
