CREATE UNIQUE INDEX "uq_integration_connections_external_identity" ON "integration_connections" USING btree ("runtime_binding_id", "provider", "external_connection_id");
