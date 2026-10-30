import { buildApp, scheduled } from "./app";
import type { Env } from "./env";

const app = buildApp();

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => app.fetch(req, env, ctx),
  scheduled: (event: ScheduledController, env: Env, ctx: ExecutionContext) => {
    ctx.waitUntil(
      scheduled(env, event.cron, event.scheduledTime).then((r) => console.log("cron", event.cron, JSON.stringify(r))),
    );
  },
} satisfies ExportedHandler<Env>;
