param(
    [ValidateSet('docker-desktop', 'minikube', 'kind', 'registry')]
    [string]$Target = 'docker-desktop',
    [string]$RegistryPrefix
)

$ErrorActionPreference = 'Stop'
$Namespace = 'techway'
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ImagePrefix = 'techway'
if ($Target -eq 'registry') {
    if ([string]::IsNullOrWhiteSpace($RegistryPrefix)) {
        throw 'Provide -RegistryPrefix, for example ghcr.io/your-org/techway.'
    }
    $ImagePrefix = $RegistryPrefix.TrimEnd('/')
}
$BackendImage = "$ImagePrefix/backend:1.0.0"
$FrontendImage = "$ImagePrefix/frontend:1.0.0"

function Invoke-Kubectl {
    & kubectl @args
    if ($LASTEXITCODE -ne 0) {
        throw "kubectl $($args -join ' ') failed with exit code $LASTEXITCODE"
    }
}

function New-RandomSecret {
    $bytes = New-Object byte[] 36
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
        $generator.GetBytes($bytes)
    }
    finally {
        $generator.Dispose()
    }
    return [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}

function Apply-WorkloadManifest {
    param(
        [string]$ManifestPath,
        [string]$DefaultImage,
        [string]$Image
    )
    if ($Target -eq 'registry') {
        $manifest = (Get-Content -Raw $ManifestPath).Replace(
            "image: $DefaultImage",
            "image: $Image"
        )
        $manifest | & kubectl apply -f -
        if ($LASTEXITCODE -ne 0) {
            throw "Applying $ManifestPath failed with registry image $Image."
        }
        return
    }
    Invoke-Kubectl apply -f $ManifestPath
}

foreach ($tool in @('docker', 'kubectl')) {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw "Required command '$tool' was not found on PATH."
    }
}
if ($Target -eq 'minikube' -and -not (Get-Command minikube -ErrorAction SilentlyContinue)) {
    throw "Required cluster image-loading command 'minikube' was not found on PATH."
}
if ($Target -eq 'kind' -and -not (Get-Command kind -ErrorAction SilentlyContinue)) {
    throw "Required cluster image-loading command 'kind' was not found on PATH."
}

$context = & kubectl config current-context
if ($LASTEXITCODE -ne 0 -or -not $context) {
    throw 'kubectl has no active cluster context. Configure a cluster and select its context first.'
}
Write-Host "Using Kubernetes context: $context"
if ($Target -eq 'docker-desktop' -and $context -notmatch 'docker-desktop') {
    throw "Context '$context' is not Docker Desktop. Choose -Target minikube or kind, or switch kubectl to the Docker Desktop context."
}
if ($Target -eq 'minikube' -and $context -notmatch 'minikube') {
    throw "Select the Minikube context before using -Target minikube (current context: '$context')."
}
if ($Target -eq 'kind' -and $context -notmatch 'kind') {
    throw "Select the kind context before using -Target kind (current context: '$context')."
}
Invoke-Kubectl get nodes

$storageClassesJson = & kubectl get storageclass -o json
if ($LASTEXITCODE -ne 0) {
    throw 'Unable to list StorageClasses. Check cluster access.'
}
$storageClasses = $storageClassesJson | ConvertFrom-Json
$hasDefaultStorageClass = @(
    $storageClasses.items | Where-Object {
        $_.metadata.annotations -and
        $_.metadata.annotations.'storageclass.kubernetes.io/is-default-class' -eq 'true'
    }
).Count -gt 0
if (-not $hasDefaultStorageClass) {
    throw 'A default StorageClass is required for the PostgreSQL PVC. Configure one, then rerun this script.'
}

Push-Location $ProjectRoot
try {
    Write-Host 'Building the frontend and backend images...'
    & docker build -t $BackendImage .\backend
    if ($LASTEXITCODE -ne 0) { throw 'Backend image build failed.' }
    & docker build -t $FrontendImage .\frontend
    if ($LASTEXITCODE -ne 0) { throw 'Frontend image build failed.' }

    if ($Target -eq 'minikube') {
        & minikube image load $BackendImage
        if ($LASTEXITCODE -ne 0) { throw 'Could not load the backend image into Minikube.' }
        & minikube image load $FrontendImage
        if ($LASTEXITCODE -ne 0) { throw 'Could not load the frontend image into Minikube.' }
    }
    elseif ($Target -eq 'kind') {
        & kind load docker-image $BackendImage
        if ($LASTEXITCODE -ne 0) { throw 'Could not load the backend image into kind.' }
        & kind load docker-image $FrontendImage
        if ($LASTEXITCODE -ne 0) { throw 'Could not load the frontend image into kind.' }
    }
    elseif ($Target -eq 'registry') {
        & docker push $BackendImage
        if ($LASTEXITCODE -ne 0) { throw "Pushing $BackendImage failed; authenticate with the registry first." }
        & docker push $FrontendImage
        if ($LASTEXITCODE -ne 0) { throw "Pushing $FrontendImage failed; authenticate with the registry first." }
    }

    Invoke-Kubectl apply -f .\k8s\namespace.yaml
    Invoke-Kubectl apply -f .\k8s\configmap.yaml
    Invoke-Kubectl apply -f .\k8s\services.yaml

    $existingSecret = & kubectl -n $Namespace get secret techway-secrets -o name --ignore-not-found
    if ($LASTEXITCODE -ne 0 -or -not $existingSecret) {
        Write-Host 'Creating application credentials in a Kubernetes Secret...'
        $postgresPassword = New-RandomSecret
        $redisPassword = New-RandomSecret
        $secretYaml = & kubectl -n $Namespace create secret generic techway-secrets `
            "--from-literal=POSTGRES_PASSWORD=$postgresPassword" `
            "--from-literal=REDIS_PASSWORD=$redisPassword" `
            --dry-run=client -o yaml
        if ($LASTEXITCODE -ne 0) { throw 'Could not generate the application Secret manifest.' }
        $secretYaml | & kubectl apply -f -
        if ($LASTEXITCODE -ne 0) { throw 'Could not apply the application Secret.' }
    }
    else {
        Write-Host 'Reusing the existing application Secret; credentials were not rotated.'
    }

    Invoke-Kubectl apply -f .\k8s\postgres-statefulset.yaml
    Invoke-Kubectl apply -f .\k8s\redis.yaml
    Apply-WorkloadManifest .\k8s\backend.yaml 'techway/backend:1.0.0' $BackendImage
    Apply-WorkloadManifest .\k8s\frontend.yaml 'techway/frontend:1.0.0' $FrontendImage
    Invoke-Kubectl apply -f .\k8s\hpa.yaml
    Invoke-Kubectl apply -f .\k8s\pdb.yaml
    Invoke-Kubectl apply -f .\k8s\networkpolicy.yaml
    Invoke-Kubectl apply -f .\k8s\ingress.yaml

    Invoke-Kubectl -n $Namespace rollout status statefulset/techway-postgres --timeout=300s
    Invoke-Kubectl -n $Namespace rollout status deployment/techway-redis --timeout=180s
    Invoke-Kubectl -n $Namespace rollout status deployment/techway-backend --timeout=300s
    Invoke-Kubectl -n $Namespace rollout status deployment/techway-frontend --timeout=180s
    Invoke-Kubectl -n $Namespace get 'pods,pvc,hpa,pdb'
}
finally {
    Pop-Location
}

Write-Host ''
Write-Host 'Deployment complete.'
Write-Host 'To route the UI and API together, install an NGINX Ingress controller and use the techway.local host configured in k8s/ingress.yaml.'
