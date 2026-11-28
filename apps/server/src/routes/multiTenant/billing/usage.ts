import { Router } from "express";
import u from "@/utils";
import { validateFields } from "@/lib/middleware";
import { success } from "@/lib/responseFormat";

export default Router().get("/", validateFields(u.multiTenant.usageQueryFields, "query"), async (req, res) => {
  res.set("Cache-Control", "no-store").json(success(await u.multiTenant.readModelUsage(req)));
});
