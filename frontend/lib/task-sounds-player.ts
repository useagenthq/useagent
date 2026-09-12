import { play, setVolume } from "cuelume";

import {
  browserTaskSoundClaim,
  createTaskSoundPlayer,
  type TaskCue,
  taskSoundsPreference,
} from "./task-sounds";

/** Quiet enough to sit under a call; the cues are short synthesized notes. */
const VOLUME = 0.5;

/** The one player the shell and the composers ring; a no-op on the server. */
export const taskSounds = createTaskSoundPlayer(
  (cue: TaskCue) => {
    setVolume(VOLUME);
    return play(cue);
  },
  taskSoundsPreference,
  Date.now,
  undefined,
  browserTaskSoundClaim(),
);
