CREATE VIEW "gateway_provider_api_key_credentials" AS
	SELECT "org_id", "user_id", "provider", "auth_method", "status", "credential_ciphertext", "iv", "tag"
	FROM "provider_connections"
	WHERE "auth_method" = 'api_key'
		AND "status" = 'connected';
