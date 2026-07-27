# Circuit Breaker Deployment Strategy

## Overview

This document describes how to deploy ProxyPay with circuit breaker protection in production environments, including health checks, recovery strategies, and operational procedures.

## Kubernetes Configuration

### Deployment with Health Checks

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: proxypay
  labels:
    app: proxypay
spec:
  replicas: 3
  selector:
    matchLabels:
      app: proxypay
  template:
    metadata:
      labels:
        app: proxypay
    spec:
      containers:
        - name: proxypay
          image: proxypay:latest
          ports:
            - containerPort: 3000
              name: http
            - containerPort: 9090
              name: metrics

          # Liveness: Restart if process is dead
          livenessProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 30
            periodSeconds: 10
            timeoutSeconds: 5
            failureThreshold: 3

          # Readiness: Remove from LB if circuit breakers critical
          readinessProbe:
            httpGet:
              path: /ready
              port: 3000
            initialDelaySeconds: 10
            periodSeconds: 5
            timeoutSeconds: 3
            failureThreshold: 2

          # Startup: Give app time to initialize
          startupProbe:
            httpGet:
              path: /health
              port: 3000
            initialDelaySeconds: 0
            periodSeconds: 2
            timeoutSeconds: 3
            failureThreshold: 30

          env:
            # Circuit breaker tuning
            - name: PROVIDER_CIRCUIT_BREAKER_TIMEOUT_MS
              value: "5000"
            - name: PROVIDER_CIRCUIT_BREAKER_RESET_TIMEOUT_MS
              value: "30000"
            - name: PROVIDER_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE
              value: "50"
            - name: PROVIDER_CIRCUIT_BREAKER_VOLUME_THRESHOLD
              value: "3"

            # Failover
            - name: PROVIDER_FAILOVER_ENABLED
              value: "true"
            - name: PROVIDER_BACKUP_MTN
              value: "airtel"
            - name: PROVIDER_BACKUP_AIRTEL
              value: "orange"

          resources:
            requests:
              cpu: 500m
              memory: 512Mi
            limits:
              cpu: 2000m
              memory: 2Gi

      # Graceful shutdown
      terminationGracePeriodSeconds: 30

---
apiVersion: v1
kind: Service
metadata:
  name: proxypay
spec:
  type: LoadBalancer
  selector:
    app: proxypay
  ports:
    - port: 3000
      targetPort: http
      protocol: TCP
```

### Horizontal Pod Autoscaling

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: proxypay-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: proxypay
  minReplicas: 3
  maxReplicas: 10
  metrics:
    # Scale on CPU usage
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70

    # Scale on memory usage
    - type: Resource
      resource:
        name: memory
        target:
          type: Utilization
          averageUtilization: 80

    # Custom metric: Circuit breaker open
    - type: Pods
      pods:
        metric:
          name: circuit_breaker_open_count
        target:
          type: AverageValue
          averageValue: "1"
```

## Health Check Endpoints

### GET /health (Liveness)

Returns `200 OK` if process is alive. This is the liveness probe.

```bash
curl http://localhost:3000/health
# Response: 200 OK
# Body: { "status": "ok" }
```

### GET /ready (Readiness)

Returns `200 OK` if ready to serve traffic, `503 Service Unavailable` if critical circuit breakers are open.

```typescript
// Implementation
app.get("/ready", async (req, res) => {
  try {
    // Check database
    const db = await checkDatabase();
    if (!db) {
      return res.status(503).json({
        status: "degraded",
        reason: "database_unavailable",
      });
    }

    // Check circuit breaker health
    const health = getCircuitBreakerHealth();
    if (health.overallStatus === "critical") {
      return res.status(503).json({
        status: "degraded",
        reason: "critical_provider_failure",
        providers: health.providers,
      });
    }

    return res.json({ status: "ready" });
  } catch (error) {
    return res.status(503).json({ status: "error" });
  }
});
```

### GET /health/lb (Load Balancer)

Returns `200 OK` if pod is healthy and can receive traffic.

```bash
curl http://localhost:3000/health/lb
# Returns 200 if healthy, 503 if degraded
```

## Deployment Scenarios

### Scenario 1: Provider Outage (MTN Down)

**Timeline:**

```
T+0s    : MTN requests start failing
T+5s    : Error rate > 50%, circuit breaker OPENS
T+5s    : Failover to Airtel begins
T+30s   : Circuit breaker tries HALF-OPEN
T+35s   : MTN recovers, circuit CLOSES
```

**Deployment Response:**

```bash
# 1. Monitor circuit breaker status
watch 'curl -s http://proxypay:3000/api/admin/circuit-breaker/health'

# 2. Confirm MTN provider is actually down
curl https://mtn-api.provider.com/health

# 3. If temporary, wait for recovery (circuit will auto-recover)
# If persistent, failover is already active (requests go to Airtel)

# 4. If manual reset needed:
curl -X POST http://proxypay:3000/api/admin/circuit-breaker/reset \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"provider": "mtn", "operation": "sendPayout"}'
```

### Scenario 2: Cascading Failure (All Providers Degraded)

**Problem:** All three providers (MTN, Airtel, Orange) are slow/failing.

**Response:**

```bash
# 1. Check overall health
curl http://proxypay:3000/api/admin/circuit-breaker/health
# Output: overallStatus = "critical"

# 2. Drain traffic from affected pod
kubectl set env deployment/proxypay PROVIDER_FAILOVER_ENABLED=false

# 3. Pod becomes unready, LB removes it
# New requests route to healthy pods

# 4. Meanwhile, your on-call team investigates provider outage

# 5. Once providers stabilized, re-enable failover
kubectl set env deployment/proxypay PROVIDER_FAILOVER_ENABLED=true

# 6. Optional: trigger rolling restart to clear circuit breakers
kubectl rollout restart deployment/proxypay
```

### Scenario 3: Recovery from Network Partition

**Problem:** Network partition between ProxyPay and Provider A resolves.

**Recovery:**

```bash
# Circuit breaker automatically recovers:
# 1. Waits for resetTimeout (30s)
# 2. Transitions to HALF-OPEN
# 3. Allows test requests
# 4. If successful, transitions to CLOSED
# 5. Traffic normalizes

# Monitor:
kubectl logs -f deployment/proxypay | grep "circuit breaker"
# Expected: "Circuit breaker half-open...", then "Circuit breaker recovered..."
```

## Operational Procedures

### Rolling Restart with Circuit Breaker

```bash
# When deploying new version, reset circuit breakers first
# to prevent cascading failures due to stale state

# 1. Get pod list
kubectl get pods -l app=proxypay

# 2. For each pod, reset circuit breakers
for pod in $(kubectl get pods -l app=proxypay -o name); do
  kubectl exec $pod -- curl -X POST localhost:3000/api/admin/circuit-breaker/reset-provider \
    -H "Content-Type: application/json" \
    -d '{"provider": "mtn"}'
done

# 3. Perform rolling restart
kubectl rollout restart deployment/proxypay

# 4. Monitor rollout
kubectl rollout status deployment/proxypay
```

### Gradual Traffic Shift (Canary Deployment)

```yaml
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: proxypay
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: proxypay
  service:
    port: 3000
  analysis:
    interval: 1m
    threshold: 5
    metrics:
      - name: request-success-rate
        thresholdRange:
          min: 99
        interval: 1m
      - name: request-duration
        thresholdRange:
          max: 500
        interval: 1m
  skipAnalysis: false
  skipAnalysis: false
  skipAnalysis: false
  progressDeadlineSeconds: 60
```

## Monitoring Circuit Breaker in Production

### Prometheus Alerts

```yaml
groups:
  - name: circuit-breaker
    interval: 30s
    rules:
      # Alert when circuit opens
      - alert: CircuitBreakerOpen
        expr: provider_circuit_breaker_state == 1
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "Provider {{ $labels.provider }} circuit is open"
          runbook_url: "https://docs.proxypay.com/runbook/circuit-breaker#open"

      # Alert when stuck open for too long
      - alert: CircuitBreakerStuckOpen
        expr: |
          (time() - circuit_breaker_last_state_change_seconds) > 600
          and
          provider_circuit_breaker_state == 1
        labels:
          severity: critical
        annotations:
          summary: "Provider {{ $labels.provider }} stuck open for >10m"
          runbook_url: "https://docs.proxypay.com/runbook/circuit-breaker#stuck"

      # Alert on high failover rate
      - alert: HighFailoverRate
        expr: rate(provider_failover_total[5m]) > 0.2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: "{{ $labels.from_provider }} failover rate > 20%"
```

### Grafana Dashboard

**Dashboard JSON (excerpt):**

```json
{
  "dashboard": {
    "title": "Circuit Breaker Status",
    "panels": [
      {
        "title": "Circuit Breaker States",
        "targets": [
          {
            "expr": "provider_circuit_breaker_state"
          }
        ],
        "type": "stat"
      },
      {
        "title": "Error Rate by Provider",
        "targets": [
          {
            "expr": "rate(provider_failures_total[5m])"
          }
        ],
        "type": "graph"
      },
      {
        "title": "Failover Events",
        "targets": [
          {
            "expr": "increase(provider_failover_total[1h])"
          }
        ],
        "type": "table"
      }
    ]
  }
}
```

## Capacity Planning

### Circuit Breaker Overhead

- **Memory**: ~5-10 MB per 100 operations tracked
- **CPU**: <1% (minimal, mostly I/O wait)
- **Network**: No external calls (local state management)

### Example Sizing

For 1000 requests/sec across 5 providers × 3 operations:

```
Instances: 3 (with HPA up to 10)
Memory per instance: 512 MB (with 256 MB for circuit breaker state)
CPU per instance: 0.5 CPU (with HPA at 70% threshold)
Failover adds: ~10% latency overhead (fallback execution)
```

## Disaster Recovery

### Circuit Breaker State Recovery

```typescript
// On startup, initialize circuit breakers from metrics
async function initializeCircuitBreakers() {
  const metrics = await loadCircuitBreakerMetricsFromPrometheus();

  for (const [provider, statuses] of Object.entries(metrics)) {
    for (const status of statuses) {
      if (status.state === "open") {
        logger.warn(`Initializing circuit breaker in open state`, {
          provider,
          operation: status.operation,
        });

        // Keep it open if too many recent failures
        if (
          status.failureCount > 10 &&
          Date.now() - status.lastStateChange.getTime() < 300000
        ) {
          openCircuitBreaker(provider, status.operation);
        }
      }
    }
  }
}
```

## Cost Optimization

### Reduce Provider Calls During Outages

When circuit breaker is open, requests fail fast with no provider cost:

```
Before Circuit Breaker:
- 1000 req/s × 5s timeout = 5000 failed requests to provider
- Cost: High (5000 × provider rate)

After Circuit Breaker:
- 1000 req/s × 50ms fail-fast = Local error response
- Cost: Zero provider calls during outage
- Savings: ~95% during provider outages
```

## Automation

### Auto-Reset on Health Recovery

```typescript
// Scheduled job to check provider health and auto-recover
schedule
  .every(1)
  .minutes()
  .do(async () => {
    const providers = ["mtn", "airtel", "orange"];

    for (const provider of providers) {
      const status = getProviderCircuitBreakerStatuses(provider);

      if (status.some((s) => s.state === "open")) {
        const isHealthy = await checkProviderHealth(provider);

        if (isHealthy) {
          resetAllCircuitBreakers(provider);
          logger.info(`Auto-recovered circuit breaker for ${provider}`);
        }
      }
    }
  });
```

---

**Related Documentation:**

- [Circuit Breaker Guide](./CIRCUIT_BREAKER_GUIDE.md)
- [Monitoring & Observability](./MONITORING.md)
- [Runbooks](./RUNBOOKS.md)
