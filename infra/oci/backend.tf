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
    # There is no `key` here, and that is deliberate. A static key is used by
    # any init that does not override it -- including a bare `terraform init`
    # run by hand -- so it would hand two operators the same state object and
    # the second apply would propose destroying the first one's box. That is
    # the hazard the Makefile's alias-derived key exists to remove, and a
    # default here would reinstate it behind the Makefile's back.
    #
    # Omitted, terraform fails closed rather than guessing: init stops with
    # `The attribute "key" is required by the backend` (verified against
    # Terraform 1.16.3). `bucket` and `region` are absent for the same reason.

    use_path_style              = true
    skip_region_validation      = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}
