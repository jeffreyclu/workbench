# CON-158: Resumable uploads — discussion guide

**Source:** [RFC PR #1301](https://github.com/WriterInternal/be.mcp-gateway/pull/1301) in `WriterInternal/be.mcp-gateway`  
**Status:** Review aid, based on commit `b5f957b`; it does not replace the RFC or its PR discussion.  
**Scope:** Uploads only. Downloads are out of scope.

## What problem this solves

Current connector uploads put the entire file into a JSON tool call as base64
text. This has three practical limits:

- The model context carries the file data, so it cannot support files around
  1 GB or larger.
- Existing uploads are limited to 90 MB.
- If an upload fails near the end, the client starts again from byte zero.

CON-158 moves file bytes out of the model/tool-call path. The model supplies
only the destination and file metadata or a stored-file reference. A program
then transfers the actual bytes.

## Proposed flow

1. The agent calls a new resumable upload tool with the destination and either
   `sourceFileId` or file metadata.
2. The gateway validates the request, starts a provider upload session, stores
   session state, and returns a transfer ticket.
3. A byte-moving client sends the file to the gateway in ordered chunks.
4. The gateway validates each chunk and streams it to the provider. It does
   not normally buffer the entire chunk.
5. The gateway records the provider-confirmed byte offset. After an
   interruption, the client reads the current offset and continues there.

The small tool call is the **control channel**. Chunk requests are the **data
channel**. The model does not receive or transmit the file bytes.

## Decisions already reflected in the RFC

| Topic | Proposed v1 decision | Why it matters |
| --- | --- | --- |
| First client | Writer Agent backend (skynet), as a background job | Stored files can be read on the private network; the model is not held open while bytes move. |
| Sandbox files | A `writer-transfer` CLI later | The CLI is for files available only inside an agent sandbox and would use the Writer backend as an authenticated proxy. |
| Chunk order | Sequential and contiguous | Progress is one offset, so retry and restart behavior stay straightforward. Provider-specific parallel work is deferred. |
| Relay behavior | Stream the request body to the provider | The gateway avoids holding full chunks in memory. A checksum-based driver such as Box may need to buffer one chunk. |
| Expiry | Use provider expiry when supplied; otherwise use a six-day default | The default stays within the roughly seven-day session lifetime described for Google and Box. |
| Existing tools | Add new `*_RESUMABLE` tools | Existing upload tools remain unchanged. |

For a large backend-mode transfer, skynet starts the work in the background and
the model receives a transfer ID and a running status. For a small transfer,
the client may wait for the final provider result when it can finish within the
tool-call time budget. The RFC proposes a 128 MiB / 120-second threshold for
this choice.

## Provider support in v1 and later

| Provider protocol | Examples | Behavior |
| --- | --- | --- |
| Resumable session | Google Drive, Microsoft Graph | A provider session accepts ordered chunks and reports the confirmed offset. This supports resume. |
| Session plus commit | Box, Adobe AEM | Chunks may require checksums and receipts, followed by an explicit final commit. This is not a v1 driver. |
| One-shot | Many custom OpenAPI connectors, Salesforce | The gateway can stream one request, but a failed transfer starts over. If the provider result is lost, the outcome is reported as unknown rather than blindly retried. |

The RFC proposes delivery order: Google first, Microsoft second, then a generic
one-shot driver. Box is deferred until there is demonstrated need for uploads
larger than 50 MB.

## Reliability contract

- The gateway stores each transfer session in Postgres, including status,
  confirmed offset, expiry, and provider-specific state.
- Offset updates use compare-and-swap so two chunk requests cannot advance the
  same session independently.
- The provider is authoritative after a gateway restart or an ambiguous
  response. Before accepting more data, the gateway re-checks the provider's
  confirmed byte count.
- The source file is revalidated on resume using its size and fingerprint or
  immutable version ID. A changed source ends the session; it is never mixed
  with an earlier version.
- For resumable providers, an interruption can lose at most the currently
  unconfirmed chunk. One-shot providers can require retransmitting the full
  request.

## Security boundary

`sourceFileId` is not accepted as authority on its own. Before a session is
created, skynet resolves the stored file under the invoking actor and
organization, rejects inaccessible or forged references without revealing
whether they exist, and records the authorized immutable identity or
fingerprint for the transfer.

Each data-channel request is independently authenticated and checked against
the organization that owns the transfer. The ticket is not a credential. In
backend mode, chunks use the caller's service identity on the private network.
For later sandbox mode, the sandbox uses its identity through the Writer
backend proxy. Provider credentials remain in the gateway.

## Evidence so far

The RFC reports two prototype validations:

- A local provider stand-in: encrypted credentials, a 96 MB CLI transfer,
  gateway termination during transfer, restart from the confirmed offset, and
  a matching final checksum.
- Google Drive: a real OAuth profile, a 96 MB upload in three chunks, then an
  interruption after the first chunk and successful resume.

The Google test exposed middleware that stripped the byte-range header. These
tests demonstrate basic feasibility; they do not demonstrate production load,
complete security coverage, or support for all providers.

## Points to settle in the review

1. Is the Google → Microsoft → generic driver order the committed sequence, and
   which customer request defines Google-first success?
2. Is polling a transfer-status tool enough for phase 1, or is a conversation
   notification required when a background transfer completes or fails?
3. Which stored-file source is in the first implementation? The RFC names
   range-readable media-service files; encrypted deliverables need an explicit
   resume approach or an explicit deferral.
4. What enables Box work: a customer commitment, a measured number of uploads
   above 50 MB, or another defined threshold?
5. Which safeguards are required before rollout: cross-organization denial,
   expired-session denial, source-file authorization, upload-URL log
   redaction, provider abort behavior, and retry-after-ambiguous-response?
6. What is the stable status response while MCP Tasks is deferred, and how
   would later task support remain compatible with it?

## Where to discuss and record decisions

The supplied team discussion did not settle a single documentation location.
It considered GitHub PR comments, Linear Docs, and a docs branch published to
Pages. Until that decision is made, use the RFC PR for implementation-specific
review and record final decisions in the merged RFC. Share this guide with
product and other cross-functional readers so they can comment on the product,
security, and rollout questions without having to reconstruct the protocol.
