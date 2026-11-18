import type { WorkerService } from '@renderer/worker/server/WorkerService';
import type { SceneManager } from '@cuemol/core/src/wrappers/SceneManager';
import type { CmdMgr } from '@cuemol/core/src/wrappers/CmdMgr';
import type { StreamManager } from '@cuemol/core/src/wrappers/StreamManager';
import type { StyleManager } from '@cuemol/core/src/wrappers/StyleManager';
import type { TaskState } from '@renderer/worker/shared/taskProgress';

export interface WorkerContext {
    svc: WorkerService;
    sceMgr: SceneManager;
    cmdMgr: CmdMgr;
    strMgr: StreamManager;
    styleMgr: StyleManager;
    /**
     * Tell the renderer what long task this call is running (the long-task
     * indicator). Bound to the call this context was built for, so a report
     * sent after an `await` still reaches that call. Optional so that a
     * context built by hand (tests) needs none; call it through
     * `services/helpers/taskReport.ts`.
     */
    reportTask?: (state: TaskState) => void;
}
