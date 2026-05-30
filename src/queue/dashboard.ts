import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import { Router } from "express";
import { deadLetterQueue } from "./dlq";
import { providerBalanceAlertQueue } from "./providerBalanceAlertQueue";

export function createQueueDashboard() {
  const router = Router();
  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath("/admin/queues");

  createBullBoard({
    queues: [
      new BullMQAdapter(providerBalanceAlertQueue),
      new BullMQAdapter(deadLetterQueue),
    ],
    serverAdapter: serverAdapter,
    options: {
      uiConfig: {
        boardTitle: "Mobile Money Queue Dashboard",
      },
    },
  });

  router.use("/", serverAdapter.getRouter());

  return router;
}
