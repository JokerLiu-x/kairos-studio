import { Router } from "express";
import u from "@/utils";
import { success } from "@/lib/responseFormat";
import { validateFields } from "@/lib/middleware";

export default Router().get("/", validateFields(u.multiTenant.commerceQueryFields, "query"), async (req, res) => {
  res.set("Cache-Control", "no-store").json(success(await u.multiTenant.readCommerce(req)));
});
