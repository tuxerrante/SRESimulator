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
Resolve the externally visible origin used by the backend for same-origin checks.
*/}}
{{- define "sre-simulator.publicOrigin" -}}
{{- if .Values.publicOrigin -}}
{{- .Values.publicOrigin -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- if .Values.ingress.tls.enabled -}}
{{- printf "https://%s" .Values.ingress.host -}}
{{- else -}}
{{- printf "http://%s" .Values.ingress.host -}}
{{- end -}}
{{- else if and .Values.route.enabled .Values.route.host -}}
{{- printf "https://%s" .Values.route.host -}}
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
