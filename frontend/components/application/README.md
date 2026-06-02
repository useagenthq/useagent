# application parts bin (`components/application`)

A deliberate parts bin of vendored application blocks (BoardUI Pro dashboard
sections: charts, data tables, settings, auth, notification center, and more).
This is NOT dead code. Product modules graduate out of this bin into real
surfaces as they are adopted - for example `app/agent/new/new-task-composer.tsx`,
`app/agent/runs/runs-list.tsx`, and the dashboard cards already compose blocks
from here.

Before assuming any file is unused, grep for its importers:

    grep -rn "@/components/application/<name>" app components

Blocks that are staged but not yet imported are kept on purpose. Do not delete
or "clean up" this directory.
