terraform {
  # OCI Object Storage through its S3-compatible endpoint.
  #
  # Partial config: bucket, endpoint and credentials are supplied at init time
  # by `make tf-oci-init`, which reads .oci-backend.env. See README.md.
  #
  # skip_s3_checksum is load-bearing. Terraform >= 1.6 uses AWS SDK v2, which
  # sends x-amz-checksum-* headers that OCI's S3 shim rejects outright.
  #
  # Credentials here are OCI *Customer Secret Keys* (an access-key/secret pair
  # generated once in the console), not the API signing key the provider uses.
  #
  # Dropping this file entirely falls back to local state with no other change.
  backend "s3" {
    key = "sre-simulator-free.tfstate"

    use_path_style              = true
    skip_region_validation      = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}
