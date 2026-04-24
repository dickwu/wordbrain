//! Shared resource management for WordBrain.
//!
//! This crate owns provider-neutral resource addressing plus optional
//! S3-compatible uploads. Callers decide where metadata is stored and which
//! domain object namespace to use.

use aws_config::Region;
use aws_credential_types::Credentials;
use aws_sdk_s3::config::Builder as S3ConfigBuilder;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client as S3Client;
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub type ResourceResult<T> = Result<T, Box<dyn std::error::Error + Send + Sync>>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceCloudSettings {
    pub enabled: bool,
    #[serde(default, alias = "upload_enabled")]
    pub upload_enabled: bool,
    #[serde(default = "default_https", alias = "endpoint_scheme")]
    pub endpoint_scheme: String,
    #[serde(default, alias = "endpoint_host")]
    pub endpoint_host: String,
    #[serde(default)]
    pub bucket: String,
    #[serde(default = "default_https", alias = "public_domain_scheme")]
    pub public_domain_scheme: String,
    #[serde(default, alias = "public_domain_host", alias = "public_domain")]
    pub public_domain_host: String,
    #[serde(default = "default_resource_prefix")]
    pub prefix: String,
    #[serde(default = "default_region")]
    pub region: String,
    #[serde(default = "default_force_path_style", alias = "force_path_style")]
    pub force_path_style: bool,
}

#[derive(Debug, Clone)]
pub struct ResourceCloudCredentials {
    pub access_key_id: String,
    pub secret_access_key: String,
}

#[derive(Debug, Clone)]
pub struct ResourceCloudConfig {
    pub settings: ResourceCloudSettings,
    pub credentials: Option<ResourceCloudCredentials>,
}

#[derive(Debug, Clone)]
pub struct ResourceCloudConfigDraft {
    pub settings: ResourceCloudSettings,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
    pub api_token: Option<String>,
}

#[derive(Debug, Clone)]
pub struct UploadedResource {
    pub key: String,
    pub public_url: String,
    pub e_tag: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParsedDomain {
    pub scheme: Option<String>,
    pub host: String,
}

pub fn default_https() -> String {
    "https".to_string()
}

pub fn default_resource_prefix() -> String {
    "wordbrain/resources".to_string()
}

pub fn default_region() -> String {
    "auto".to_string()
}

pub fn default_force_path_style() -> bool {
    true
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct ResourceCloudSettingsInput {
    #[serde(alias = "account_id")]
    account_id: Option<String>,
    enabled: Option<bool>,
    #[serde(alias = "upload_enabled")]
    upload_enabled: Option<bool>,
    #[serde(alias = "endpoint_scheme")]
    endpoint_scheme: Option<String>,
    #[serde(
        alias = "endpoint_host",
        alias = "endpoint",
        alias = "endpoint_url",
        alias = "endpointUrl"
    )]
    endpoint_host: Option<String>,
    bucket: Option<String>,
    #[serde(alias = "public_domain_scheme")]
    public_domain_scheme: Option<String>,
    #[serde(
        alias = "public_domain_host",
        alias = "public_domain",
        alias = "publicDomain",
        alias = "domain"
    )]
    public_domain_host: Option<String>,
    prefix: Option<String>,
    region: Option<String>,
    #[serde(alias = "force_path_style")]
    force_path_style: Option<bool>,
    #[serde(alias = "access_key_id")]
    access_key_id: Option<String>,
    #[serde(alias = "secret_access_key")]
    secret_access_key: Option<String>,
    #[serde(alias = "api_token")]
    api_token: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct R2Export {
    account: Option<R2Account>,
    #[serde(default)]
    tokens: Vec<R2TokenBundle>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct R2Account {
    id: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct R2TokenBundle {
    token: Option<R2Token>,
    #[serde(default)]
    buckets: Vec<R2Bucket>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct R2Token {
    api_token: Option<String>,
    access_key_id: Option<String>,
    secret_access_key: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct R2Bucket {
    name: Option<String>,
    public_domain: Option<String>,
    public_domain_scheme: Option<String>,
}

impl Default for ResourceCloudSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            upload_enabled: false,
            endpoint_scheme: default_https(),
            endpoint_host: String::new(),
            bucket: String::new(),
            public_domain_scheme: default_https(),
            public_domain_host: String::new(),
            prefix: default_resource_prefix(),
            region: default_region(),
            force_path_style: default_force_path_style(),
        }
    }
}

impl ResourceCloudSettings {
    pub fn validate_public(&self) -> ResourceResult<()> {
        if !self.enabled {
            return Ok(());
        }
        validate_scheme(&self.public_domain_scheme, "file server domain scheme")?;
        if self.public_domain_host.trim().is_empty() {
            return Err("file server domain is required when cloud resources are enabled".into());
        }
        Ok(())
    }

    pub fn validate_upload(&self) -> ResourceResult<()> {
        if !self.upload_enabled {
            return Ok(());
        }
        validate_scheme(&self.endpoint_scheme, "endpoint scheme")?;
        if self.endpoint_host.trim().is_empty() {
            return Err("endpoint hostname is required when resource upload is enabled".into());
        }
        if self.bucket.trim().is_empty() {
            return Err("bucket is required when resource upload is enabled".into());
        }
        Ok(())
    }

    pub fn public_base_enabled(&self) -> bool {
        self.enabled && !self.public_domain_host.trim().is_empty()
    }
}

impl ResourceCloudSettingsInput {
    fn into_draft(self, default_prefix_value: &str) -> ResourceCloudConfigDraft {
        let account_id = non_empty_string(self.account_id.as_deref());
        let endpoint_host = self.endpoint_host.or_else(|| {
            account_id
                .as_ref()
                .map(|id| format!("{id}.r2.cloudflarestorage.com"))
        });
        let endpoint = parse_domain_input(endpoint_host.as_deref());
        let public_domain = parse_domain_input(self.public_domain_host.as_deref());
        let bucket = trim_string(self.bucket);
        let access_key_id = non_empty_string(self.access_key_id.as_deref());
        let secret_access_key = non_empty_string(self.secret_access_key.as_deref());
        let api_token = non_empty_string(self.api_token.as_deref());
        let upload_enabled = self.upload_enabled.unwrap_or_else(|| {
            !endpoint.host.trim().is_empty()
                && !bucket.is_empty()
                && access_key_id.is_some()
                && secret_access_key.is_some()
        });
        let enabled = self
            .enabled
            .unwrap_or_else(|| upload_enabled || !public_domain.host.trim().is_empty());

        ResourceCloudConfigDraft {
            settings: ResourceCloudSettings {
                enabled,
                upload_enabled,
                endpoint_scheme: normalize_scheme(
                    endpoint
                        .scheme
                        .as_deref()
                        .or(self.endpoint_scheme.as_deref()),
                ),
                endpoint_host: endpoint.host,
                bucket,
                public_domain_scheme: normalize_scheme(
                    public_domain
                        .scheme
                        .as_deref()
                        .or(self.public_domain_scheme.as_deref()),
                ),
                public_domain_host: public_domain.host,
                prefix: clean_resource_path(self.prefix.as_deref().unwrap_or(default_prefix_value)),
                region: self
                    .region
                    .as_deref()
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .unwrap_or("auto")
                    .to_string(),
                force_path_style: self.force_path_style.unwrap_or(true),
            },
            access_key_id,
            secret_access_key,
            api_token,
        }
    }
}

impl ResourceCloudConfig {
    pub fn can_upload(&self) -> bool {
        self.settings.enabled
            && self.settings.upload_enabled
            && !self.settings.endpoint_host.trim().is_empty()
            && !self.settings.bucket.trim().is_empty()
            && self.credentials.as_ref().is_some_and(|creds| {
                !creds.access_key_id.trim().is_empty() && !creds.secret_access_key.trim().is_empty()
            })
    }

    pub async fn upload_bytes(
        &self,
        namespace: &str,
        resource_path: &str,
        media_type: &str,
        content: Vec<u8>,
    ) -> ResourceResult<UploadedResource> {
        if !self.can_upload() {
            return Err("resource cloud upload is not configured".into());
        }

        let key = object_key(&self.settings, namespace, resource_path);
        let client = create_s3_client(self)?;
        let mut request = client
            .put_object()
            .bucket(&self.settings.bucket)
            .key(&key)
            .body(ByteStream::from(content));
        if !media_type.trim().is_empty() {
            request = request.content_type(media_type);
        }
        let response = request.send().await?;
        let e_tag = response.e_tag().unwrap_or_default().to_string();
        let public_url = public_url_for_key(&self.settings, &key);

        Ok(UploadedResource {
            key,
            public_url,
            e_tag,
        })
    }
}

pub fn cloud_config_draft_from_value(
    value: Value,
    default_prefix_value: &str,
) -> ResourceResult<ResourceCloudConfigDraft> {
    if let Some(draft) = draft_from_r2_export(&value, default_prefix_value) {
        return Ok(draft);
    }

    let input: ResourceCloudSettingsInput = serde_json::from_value(value)?;
    Ok(input.into_draft(default_prefix_value))
}

fn draft_from_r2_export(
    value: &Value,
    default_prefix_value: &str,
) -> Option<ResourceCloudConfigDraft> {
    let export: R2Export = serde_json::from_value(value.clone()).ok()?;
    let looks_like_r2 = export
        .account
        .as_ref()
        .and_then(|account| non_empty_string(account.id.as_deref()))
        .is_some()
        || !export.tokens.is_empty();
    if !looks_like_r2 {
        return None;
    }

    let account_id = export
        .account
        .as_ref()
        .and_then(|account| non_empty_string(account.id.as_deref()));
    let token_bundle = export.tokens.first();
    let token = token_bundle.and_then(|bundle| bundle.token.as_ref());
    let bucket = token_bundle
        .and_then(|bundle| {
            bundle
                .buckets
                .iter()
                .find(|bucket| non_empty_string(bucket.public_domain.as_deref()).is_some())
                .or_else(|| bundle.buckets.first())
        })
        .cloned()
        .unwrap_or_default();

    let endpoint_host = account_id
        .as_ref()
        .map(|id| format!("{}.r2.cloudflarestorage.com", id.trim()));
    let public_domain = parse_domain_input(bucket.public_domain.as_deref());
    let public_domain_scheme = public_domain
        .scheme
        .as_deref()
        .or(bucket.public_domain_scheme.as_deref());
    let bucket_name = trim_string(bucket.name);
    let access_key_id = token.and_then(|token| non_empty_string(token.access_key_id.as_deref()));
    let secret_access_key =
        token.and_then(|token| non_empty_string(token.secret_access_key.as_deref()));
    let api_token = token.and_then(|token| non_empty_string(token.api_token.as_deref()));
    let upload_enabled = endpoint_host
        .as_ref()
        .is_some_and(|value| !value.is_empty())
        && !bucket_name.is_empty()
        && access_key_id.is_some()
        && secret_access_key.is_some();
    let enabled = upload_enabled || !public_domain.host.trim().is_empty();

    Some(ResourceCloudConfigDraft {
        settings: ResourceCloudSettings {
            enabled,
            upload_enabled,
            endpoint_scheme: "https".to_string(),
            endpoint_host: endpoint_host.unwrap_or_default(),
            bucket: bucket_name,
            public_domain_scheme: normalize_scheme(public_domain_scheme),
            public_domain_host: public_domain.host,
            prefix: clean_resource_path(default_prefix_value),
            region: "auto".to_string(),
            force_path_style: true,
        },
        access_key_id,
        secret_access_key,
        api_token,
    })
}

pub fn parse_domain_input(value: Option<&str>) -> ParsedDomain {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return ParsedDomain {
            scheme: None,
            host: String::new(),
        };
    };

    if value.contains("://") {
        if let Ok(url) = url::Url::parse(value) {
            let host = url.host_str().unwrap_or_default();
            let port = url
                .port()
                .map(|port| format!(":{port}"))
                .unwrap_or_default();
            return ParsedDomain {
                scheme: Some(url.scheme().to_lowercase()),
                host: format!("{host}{port}").trim_end_matches('/').to_string(),
            };
        }
    }

    ParsedDomain {
        scheme: None,
        host: value
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_end_matches('/')
            .to_string(),
    }
}

pub fn normalize_prefix(value: &str) -> String {
    clean_resource_path(value)
}

pub fn clean_resource_path(value: &str) -> String {
    let normalized = value.trim().replace('\\', "/");
    normalized
        .trim_start_matches("./")
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.trim().is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn object_key(
    settings: &ResourceCloudSettings,
    namespace: &str,
    resource_path: &str,
) -> String {
    let prefix = normalize_prefix(&settings.prefix);
    let namespace = clean_resource_path(namespace);
    let resource_path = clean_resource_path(resource_path);
    [prefix, namespace, resource_path]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("/")
}

pub fn public_url_for_file(
    settings: &ResourceCloudSettings,
    namespace: &str,
    resource_path: &str,
) -> String {
    public_url_for_key(settings, &object_key(settings, namespace, resource_path))
}

pub fn public_url_for_key(settings: &ResourceCloudSettings, key: &str) -> String {
    format!(
        "{}://{}/{}",
        settings.public_domain_scheme,
        settings.public_domain_host.trim_end_matches('/'),
        percent_encode_path(key)
    )
}

pub fn percent_encode_path(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        match *byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(*byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn normalize_scheme(value: Option<&str>) -> String {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("https")
        .to_lowercase()
}

fn trim_string(value: Option<String>) -> String {
    value
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or_default()
        .to_string()
}

fn non_empty_string(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

fn create_s3_client(config: &ResourceCloudConfig) -> ResourceResult<S3Client> {
    let Some(credentials) = config.credentials.as_ref() else {
        return Err("resource cloud credentials are not configured".into());
    };
    let credentials = Credentials::new(
        credentials.access_key_id.clone(),
        credentials.secret_access_key.clone(),
        None,
        None,
        "wordbrain-resource-manager",
    );
    let endpoint_url = format!(
        "{}://{}",
        config.settings.endpoint_scheme, config.settings.endpoint_host
    );
    let mut builder = S3ConfigBuilder::new()
        .credentials_provider(credentials)
        .region(Region::new(config.settings.region.clone()))
        .endpoint_url(endpoint_url);
    if config.settings.force_path_style {
        builder = builder.force_path_style(true);
    }
    Ok(S3Client::from_conf(builder.build()))
}

fn validate_scheme(value: &str, label: &str) -> ResourceResult<()> {
    if matches!(value, "http" | "https") {
        Ok(())
    } else {
        Err(format!("{label} must be http or https").into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_keys_are_namespaced_and_normalized() {
        let settings = ResourceCloudSettings {
            prefix: "/wordbrain/dictionaries/".to_string(),
            ..ResourceCloudSettings::default()
        };

        assert_eq!(
            object_key(&settings, "/42/", r".\audio\gb\word.mp3"),
            "wordbrain/dictionaries/42/audio/gb/word.mp3"
        );
    }

    #[test]
    fn public_urls_percent_encode_resource_paths() {
        let settings = ResourceCloudSettings {
            public_domain_scheme: "https".to_string(),
            public_domain_host: "cdn.example.test".to_string(),
            prefix: "wordbrain/dictionaries".to_string(),
            ..ResourceCloudSettings::default()
        };

        assert_eq!(
            public_url_for_file(&settings, "7", "images/hello world.png"),
            "https://cdn.example.test/wordbrain/dictionaries/7/images/hello%20world.png"
        );
    }

    #[test]
    fn public_only_config_does_not_require_upload_credentials() {
        let settings = ResourceCloudSettings {
            enabled: true,
            upload_enabled: false,
            public_domain_host: "cdn.example.test".to_string(),
            ..ResourceCloudSettings::default()
        };
        let config = ResourceCloudConfig {
            settings,
            credentials: None,
        };

        assert!(config.settings.validate_public().is_ok());
        assert!(!config.can_upload());
        assert!(config.settings.public_base_enabled());
    }

    #[test]
    fn r2_export_maps_to_s3_endpoint_and_public_domain() {
        let value = serde_json::json!({
            "provider": "r2",
            "account": { "id": "abc123" },
            "tokens": [{
                "token": {
                    "api_token": "api",
                    "access_key_id": "access",
                    "secret_access_key": "secret"
                },
                "buckets": [{
                    "name": "word",
                    "public_domain": "word.example.test",
                    "public_domain_scheme": "https"
                }]
            }]
        });

        let draft = cloud_config_draft_from_value(value, "wordbrain/dictionaries").unwrap();

        assert!(draft.settings.enabled);
        assert!(draft.settings.upload_enabled);
        assert_eq!(
            draft.settings.endpoint_host,
            "abc123.r2.cloudflarestorage.com"
        );
        assert_eq!(draft.settings.bucket, "word");
        assert_eq!(draft.settings.public_domain_host, "word.example.test");
        assert_eq!(draft.access_key_id.as_deref(), Some("access"));
        assert_eq!(draft.secret_access_key.as_deref(), Some("secret"));
        assert_eq!(draft.api_token.as_deref(), Some("api"));
    }

    #[test]
    fn flat_config_accepts_snake_case_aliases() {
        let value = serde_json::json!({
            "enabled": true,
            "upload_enabled": false,
            "public_domain_host": "https://cdn.example.test/",
            "prefix": "/wordbrain/test/"
        });

        let draft = cloud_config_draft_from_value(value, "wordbrain/dictionaries").unwrap();

        assert_eq!(draft.settings.public_domain_scheme, "https");
        assert_eq!(draft.settings.public_domain_host, "cdn.example.test");
        assert_eq!(draft.settings.prefix, "wordbrain/test");
    }

    #[test]
    fn flat_r2_config_uses_account_id_endpoint() {
        let value = serde_json::json!({
            "provider": "r2",
            "account_id": "abc123",
            "bucket": "word",
            "access_key_id": "access",
            "secret_access_key": "secret",
            "public_domain": "https://word.example.test"
        });

        let draft = cloud_config_draft_from_value(value, "wordbrain/dictionaries").unwrap();

        assert!(draft.settings.enabled);
        assert!(draft.settings.upload_enabled);
        assert_eq!(
            draft.settings.endpoint_host,
            "abc123.r2.cloudflarestorage.com"
        );
        assert_eq!(draft.settings.public_domain_scheme, "https");
        assert_eq!(draft.settings.public_domain_host, "word.example.test");
        assert_eq!(draft.access_key_id.as_deref(), Some("access"));
        assert_eq!(draft.secret_access_key.as_deref(), Some("secret"));
    }
}
