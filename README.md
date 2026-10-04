# Techway Tasks on Kubernetes

Techway is a small, runnable task-list application: a static web frontend, a Node.js REST API, PostgreSQL persistence, and Redis read caching. Kubernetes manifests and a Helm chart demonstrate rollouts, health checks, recovery, persistent storage, autoscaling, and tier-level network policy.

## Architecture

```text
 Browser
   │
   ▼
 NGINX Ingress Controller
   ├── /      ──► techway-frontend Service ──► 2 static frontend Pods
   └── /api   ──► techway-backend Service  ──► 2+ API Pods ──┬──► PostgreSQL StatefulSet + PVC
                                                             └──► Redis cache
```

The API supports `GET /api/tasks`, `POST /api/tasks` with `{"title":"..."}`, and `DELETE /api/tasks/:id`. PostgreSQL stores tasks; Redis caches task-list reads. The API remains usable if Redis is unavailable by falling back to PostgreSQL. `/health` checks the API process; `/ready` checks PostgreSQL.

## Prerequisites

- A working Kubernetes cluster and `kubectl` configured to use its context
- Docker Engine for building the app images
- A default `StorageClass` that can dynamically provision a 20 GiB ReadWriteOnce PVC
- For local clusters:
  - Docker Desktop Kubernetes: run the default deployment script
  - Minikube: install the `minikube` CLI
  - kind: install the `kind` CLI
- An Ingress controller to access both the UI and API at one host; these manifests target NGINX Ingress
- `metrics-server` for HPA metrics (otherwise the HPA will show `<unknown>`)

Check the selected cluster and storage before deploying:

```powershell
kubectl config current-context
kubectl get nodes
kubectl get storageclass
kubectl top nodes
```

The storage-class list must include one marked `(default)`. If there is no default class, configure one for your cluster before deployment. A kind cluster needs a storage provisioner such as Rancher's local-path-provisioner, marked as the default class. `kubectl top nodes` should work for HPA scaling; install or enable metrics-server if it does not.

If the cluster has no NGINX Ingress controller and Helm is installed, install it before using the Ingress:

```powershell
helm repo add ingress-nginx https://kubernetes.github.io/ingress-nginx
helm repo update
helm upgrade --install ingress-nginx ingress-nginx/ingress-nginx `
  --namespace ingress-nginx --create-namespace
```

Install metrics-server according to your cluster provider. Some local clusters require their provider-specific metrics add-on.

## Deploy on a local cluster

From the project root in PowerShell:

```powershell
.\scripts\deploy.ps1
```

For Minikube or kind, pass the cluster type so the script loads the locally built images into the cluster:

```powershell
.\scripts\deploy.ps1 -Target minikube
.\scripts\deploy.ps1 -Target kind
```

The script builds `techway/backend:1.0.0` and `techway/frontend:1.0.0`, creates the `techway` namespace and ConfigMap, generates random database/cache credentials in a Kubernetes Secret, and applies the application resources in dependency order. It reuses an existing Secret on subsequent runs rather than rotating credentials behind the database's back.

For a remote cluster, authenticate with a container registry and let the script build and push both images before applying the Kubernetes resources:

```powershell
docker login ghcr.io
.\scripts\deploy.ps1 -Target registry -RegistryPrefix ghcr.io/your-org/techway
```

The resulting image names are `ghcr.io/your-org/techway/backend:1.0.0` and `ghcr.io/your-org/techway/frontend:1.0.0`. Ensure the cluster can pull them; configure `imagePullSecrets` for a private registry. Do not commit real credentials or replace the generated Secret with public example passwords.

## Check the deployment

```powershell
kubectl -n techway get pods,pvc,hpa,pdb
kubectl -n techway rollout status statefulset/techway-postgres
kubectl -n techway rollout status deployment/techway-redis
kubectl -n techway rollout status deployment/techway-backend
kubectl -n techway rollout status deployment/techway-frontend
kubectl -n techway get hpa
```

With the NGINX Ingress controller installed, port-forward its controller service in one terminal:

```powershell
kubectl -n ingress-nginx port-forward service/ingress-nginx-controller 8080:80
```

For browser access, add `127.0.0.1 techway.local` to the Windows hosts file and open `http://techway.local:8080/`. Or use `curl.exe` with the host header:

```powershell
curl.exe -H "Host: techway.local" http://localhost:8080/
curl.exe -H "Host: techway.local" http://localhost:8080/api/tasks
```

To create a task from PowerShell:

```powershell
'{"title":"Check the deployment"}' | Out-File -Encoding ascii body.json
curl.exe -H "Host: techway.local" -H "Content-Type: application/json" -d "@body.json" http://localhost:8080/api/tasks
```

![](https://github.com/aatikah/resilient-kubernetes-application/blob/main/images/app.png)

![](https://github.com/aatikah/resilient-kubernetes-application/blob/main/images/pods.png)

## Deploy with Helm

The chart is also included at `helm/techway-app`. Provide credentials at deployment time rather than storing them in `values.yaml`:

```powershell
helm upgrade --install techway .\helm\techway-app `
  --namespace techway --create-namespace `
  --set-string secrets.postgresPassword="<strong-password>" `
  --set-string secrets.redisPassword="<strong-password>"
```

Use a secrets manager or externally managed Kubernetes Secret for production deployments.

![](https://github.com/aatikah/resilient-kubernetes-application/blob/main/images/via-helm.png)

## Run the API unit tests

```powershell
Push-Location .\backend
npm install
npm test
Pop-Location
```



### Local container smoke test

The built frontend and backend images were exercised locally with PostgreSQL and Redis containers. API readiness, task creation/listing, frontend serving and `/healthz`, and task persistence across a PostgreSQL container restart (with Redis cache cleared) passed. This verifies the application containers, not Kubernetes rollout, autoscaling, NetworkPolicy, or PVC behavior.

### Zero-downtime API rollout

Build and load a second version of the API image (for kind or Minikube, load it as shown above), then run an HTTP loop in one terminal:

```powershell
docker build -t techway/backend:1.0.1 .\backend
# For kind: kind load docker-image techway/backend:1.0.1
# For Minikube: minikube image load techway/backend:1.0.1
kubectl -n techway run rollout-probe --rm -i --restart=Never --image=curlimages/curl -- `
  sh -c 'i=0; errors=0; while [ $i -lt 200 ]; do code=$(curl -sS -o /dev/null -w "%{http_code}" http://techway-backend/health); case "$code" in 2*) ;; *) errors=$((errors+1));; esac; i=$((i+1)); done; echo "non-2xx responses: $errors"; test "$errors" -eq 0'
```

In another terminal, update the backend to the new, cluster-accessible image:

```powershell
kubectl -n techway set image deployment/techway-backend backend=techway/backend:1.0.1
kubectl -n techway rollout status deployment/techway-backend
```

Save the probe output and rollout status. The Deployment uses `maxSurge: 1` and `maxUnavailable: 0`; whether the test actually saw zero 5xx responses must be established from your run.

### Self-healing

```powershell
$pod = kubectl -n techway get pods -l app=techway-backend -o jsonpath='{.items[0].metadata.name}'
kubectl -n techway delete pod $pod
kubectl -n techway get pods -l app=techway-backend -w
```

Confirm the Deployment creates replacement pod(s) and they become Ready.

### Horizontal autoscaling

Confirm metrics-server is reporting:

```powershell
kubectl -n techway get hpa
kubectl top pods -n techway
```

With the Ingress port-forward active, generate concurrent HTTP traffic against `/api/tasks` using a load generator such as `hey`:

```powershell
kubectl -n ingress-nginx run load-gen2 --rm -i --restart=Never `
  --labels="app.kubernetes.io/name=ingress-nginx,app.kubernetes.io/component=controller" `
  --image=williamyeh/hey -- -z 3m -c 300 http://techway-backend.techway/api/tasks
```

In another terminal, watch `kubectl -n techway get hpa -w`. The HPA target is 70% CPU utilization, with 2–8 backend replicas. Record whether the replica count increased; the API's resource requests are the basis of the utilization percentage.

![](https://github.com/aatikah/resilient-kubernetes-application/blob/main/images/autoscaling.png)

### PostgreSQL data persistence

Use the application, create a task, and verify it appears in `GET /api/tasks`. Then delete and wait for the database pod:

```powershell
kubectl -n techway delete pod techway-postgres-0
kubectl -n techway wait --for=condition=Ready pod/techway-postgres-0 --timeout=300s
kubectl -n techway exec deployment/techway-redis -- sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli DEL tasks:list'
```

Fetch the task list again and verify the created task is still present. The StatefulSet recreates the pod with its existing PVC.

## Kubernetes resources and security

- Namespace, ConfigMap, generated Secret, Services, Ingress, Deployments, StatefulSet/PVC, HPA, PDBs, and NetworkPolicy
- Frontend and API run as non-root with read-only root filesystems
- PostgreSQL data is on a persistent volume; Redis is an ephemeral cache
- The API has no user authentication and is intended as a deployment demo; do not expose it publicly without adding authentication and authorization
- Application containers have resource requests/limits and liveness/readiness probes
- NetworkPolicy permits Ingress-controller traffic to the web/API ports, API traffic to PostgreSQL/Redis, and DNS
- Use a CNI that enforces Kubernetes NetworkPolicies; some default cluster network plugins require policy enforcement to be enabled separately
- Ingress is plain HTTP by default. Configure TLS with a real DNS name, certificate, and TLS Secret if needed.

## Project layout

```text
backend/             Node.js API, tests, and Dockerfile
frontend/            Static UI, NGINX config, and Dockerfile
k8s/                 Kubernetes manifests
helm/techway-app/     Optional Helm chart
scripts/deploy.ps1   Local cluster build and deployment helper
```
