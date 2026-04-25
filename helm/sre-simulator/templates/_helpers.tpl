{{/*
Expand the name of the chart.
*/}}
{{- define "sre-simulator.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "sre-simulator.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "sre-simulator.labels" -}}
helm.sh/chart: {{ include "sre-simulator.name" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}

{{/*
Frontend selector labels
*/}}
{{- define "sre-simulator.frontend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sre-simulator.name" . }}
app.kubernetes.io/component: frontend
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Helm test selector labels
*/}}
{{- define "sre-simulator.helmTest.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sre-simulator.name" . }}
app.kubernetes.io/component: helm-test
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Backend selector labels
*/}}
{{- define "sre-simulator.backend.selectorLabels" -}}
app.kubernetes.io/name: {{ include "sre-simulator.name" . }}
app.kubernetes.io/component: backend
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Resolve the public exposure mode.
*/}}
{{- define "sre-simulator.exposureMode" -}}
{{- if .Values.exposure.mode -}}
{{- .Values.exposure.mode -}}
{{- else if .Values.route.enabled -}}
{{- print "route" -}}
{{- else if .Values.ingress.enabled -}}
{{- print "ingress" -}}
{{- else if .Values.frontend.service.public.enabled -}}
{{- print "publicService" -}}
{{- else -}}
{{- print "none" -}}
{{- end -}}
{{- end }}

{{/*
Validate gateway-mode exposure settings before rendering dependent resources.
*/}}
{{- define "sre-simulator.validateGatewayExposure" -}}
{{- $mode := include "sre-simulator.exposureMode" . -}}
{{- if eq $mode "gateway" -}}
{{- $host := .Values.exposure.host | default "" | trim -}}
{{- if not $host -}}
{{- fail "exposure.host is required when exposure.mode=gateway" -}}
{{- end -}}
{{- if and .Values.exposure.scheme (ne .Values.exposure.scheme "https") -}}
{{- fail "exposure.scheme must be empty or https when exposure.mode=gateway" -}}
{{- end -}}
{{- end -}}
{{- end }}

{{/*
Resolve the externally visible host.
*/}}
{{- define "sre-simulator.publicHost" -}}
{{- $mode := include "sre-simulator.exposureMode" . -}}
{{- include "sre-simulator.validateGatewayExposure" . -}}
{{- if eq $mode "gateway" -}}
{{- .Values.exposure.host | default "" | trim -}}
{{- else if .Values.exposure.host -}}
{{- .Values.exposure.host -}}
{{- else if .Values.route.host -}}
{{- .Values.route.host -}}
{{- else if .Values.ingress.host -}}
{{- .Values.ingress.host -}}
{{- end -}}
{{- end }}

{{/*
Resolve the externally visible scheme.
*/}}
{{- define "sre-simulator.publicScheme" -}}
{{- $mode := include "sre-simulator.exposureMode" . -}}
{{- include "sre-simulator.validateGatewayExposure" . -}}
{{- if eq $mode "gateway" -}}
{{- print "https" -}}
{{- else if .Values.exposure.scheme -}}
{{- .Values.exposure.scheme -}}
{{- else if eq $mode "route" -}}
{{- print "https" -}}
{{- else if and (eq $mode "ingress") .Values.ingress.tls.enabled -}}
{{- print "https" -}}
{{- else -}}
{{- print "http" -}}
{{- end -}}
{{- end }}

{{/*
Resolve the externally visible origin used by the backend for same-origin checks.
*/}}
{{- define "sre-simulator.publicOrigin" -}}
{{- if .Values.publicOrigin -}}
{{- .Values.publicOrigin -}}
{{- else if include "sre-simulator.publicHost" . -}}
{{- printf "%s://%s" (include "sre-simulator.publicScheme" .) (include "sre-simulator.publicHost" .) -}}
{{- else -}}
{{- printf "http://localhost" -}}
{{- end -}}
{{- end }}

{{/*
Optional image pull secrets for private registries.
*/}}
{{- define "sre-simulator.imagePullSecrets" -}}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{- range . }}
  - name: {{ . }}
{{- end }}
{{- end }}
{{- end }}
