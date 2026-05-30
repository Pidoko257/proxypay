{{/*
Common helper templates used by the Mobile Money Helm chart.
*/}}
{{- define "mobile-money.fullname" -}}
{{- printf "%s-%s" .Release.Name "mobile-money" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "mobile-money.name" -}}
{{- printf "%s" "mobile-money" -}}
{{- end -}}

{{- define "mobile-money.labels" -}}
app.kubernetes.io/name: {{ include "mobile-money.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version }}
{{- if .Values.labels }}
{{ toYaml .Values.labels | trim | indent 0 }}
{{- end -}}
{{- end -}}
