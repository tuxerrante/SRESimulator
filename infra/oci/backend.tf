terraform {
  # OCI Object Storage through its S3-compatible endpoint.
  #
  # Partial config: bucket, endpoint and credentials are supplied at init time
  # by `make tf-oci-init`, which reads .oci-backend.env. See README.md.
  #
  # skip_s3_checksum drops the SHA256 checksum Terraform asks the AWS SDK to
  # compute -- x-amz-checksum-sha256 plus x-amz-sdk-checksum-algorithm -- which
  # OCI's S3 shim rejects.
  #
  # It does not leave the request checksum-free. Measured against Terraform
  # 1.16.3 with a logging stub endpoint: with the flag set, PutObject still
  # carries the SDK's own default full-object x-amz-checksum-crc32. If OCI
  # rejects that one too, the remedy is the SDK's own switch rather than
  # anything in this file -- AWS_REQUEST_CHECKSUM_CALCULATION=when_required
  # removes the header entirely, verified on the same stub, and tf-oci-* export
  # it for exactly that reason.
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

    # State locking. Without it two operators sharing a key -- which the
    # Makefile's OCI_STATE_KEY makes possible on purpose, for a second machine
    # driving the same box -- can plan and apply concurrently and the second
    # write silently discards the first. Bucket versioning recovers the object
    # afterwards; it does not stop the race.
    #
    # use_lockfile is Terraform's backend-native lock: a <key>.tflock object
    # written with `If-None-Match: *`, so the mutual exclusion is the object
    # store's conditional-create, not a side table. Confirmed to be the actual
    # wire behaviour on Terraform 1.16.3 against a logging stub endpoint -- PUT
    # <key>.tflock with if-none-match: *, GET it on release, DELETE it -- which
    # is why versions.tf floors at 1.10, where the option was introduced.
    #
    # The residual risk is named rather than hidden: if OCI's S3 shim ignores
    # the precondition and overwrites instead of failing with 412, two
    # simultaneous applies would each believe they hold the lock. That cannot
    # be tested from here without the tenancy, so README.md's bootstrap section
    # carries the one-command check to run on the real bucket before trusting
    # it, and the alias-derived key keeps the ordinary single-operator case
    # unshared regardless.
    use_lockfile = true

    use_path_style              = true
    skip_region_validation      = true
    skip_credentials_validation = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }
}
