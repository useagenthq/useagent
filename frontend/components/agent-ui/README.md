# agent-ui parts bin (`components/agent-ui`)

A deliberate parts bin of vendored agent-UI blocks (ported from beautiful-ui,
the component catalog). This is NOT dead code. Product modules
graduate out of this bin into real surfaces as they are adopted - for example
`components/chat/conversation.tsx` and `components/chat/tool-step-row.tsx`
already compose blocks from here.

Before assuming any file is unused, grep for its importers:

    grep -rn "@/components/agent-ui/<name>" app components

Blocks that are staged but not yet imported are kept on purpose. Do not delete
or "clean up" this directory.
