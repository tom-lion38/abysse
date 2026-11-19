# Installer Abysse

Ce guide part d'un hôte Proxmox VE et installe Abysse dans un CT Debian 13. Toutes les
adresses sont des exemples : le réseau local est en `192.168.10.0/24`, le VPN en
`10.8.0.0/24`, le CT d'Abysse en `192.168.10.169`.

Avant de commencer, une chose à garder en tête : **Abysse n'a pas de compte ni de mot de
passe**. Il montre toute l'infra et permet de renommer ou cacher des éléments. Il doit
rester sur le réseau local et le VPN, jamais derrière un reverse proxy public.

## 1. Créer le CT

Sur l'hôte Proxmox, en root, avec le script fourni :

```
CTID=150 IP=192.168.10.169/24 GW=192.168.10.198 bash deploy/creer-ct.sh
```

Il crée un CT non privilégié (2 cœurs, 1 Go de RAM, 8 Go de disque), le démarre et
installe `python3`, `nftables`, `curl` et `git`. Variables facultatives : `DNS`,
`BRIDGE` (défaut `vmbr0`), `STOCKAGE` (défaut `local-lvm`), `MODELE`.

On peut aussi créer le CT à la main dans l'interface : Debian 13, 1 Go de RAM suffit
largement.

## 2. Installer le code

Dans le CT (`pct enter 150`) :

```
git clone https://github.com/tom-lion38/abysse /root/abysse
cd /root/abysse
bash deploy/installer.sh
```

Le script crée l'utilisateur système `abysse`, copie le code dans `/opt/abysse`, installe
le service systemd et copie les fichiers d'exemple dans `/etc/abysse/` s'ils n'existent
pas encore :

- `/etc/abysse/abysse.env` : adresses et secrets des sources (droits 600) ;
- `/etc/abysse/inventaire.json` : les équipements fixes (étape 5) ;
- `/etc/abysse/sites.json` : la liste des sites (étape 4).

À ce stade le service tourne, mais sans source : la carte est vide. On branche les sources
une par une, en remplissant `abysse.env`, puis `systemctl restart abysse`. Chaque source
est facultative.

## 3. Les accès en lecture seule

### Proxmox VE

Sur l'hôte Proxmox :

```
pveum user add abysse@pve --comment "Abysse, lecture seule"
pveum acl modify / --users abysse@pve --roles PVEAuditor
pveum user token add abysse@pve lecture --privsep 0
```

La dernière commande affiche le secret du jeton une seule fois. Dans `abysse.env` :

```
ABYSSE_PVE_URL=https://192.168.10.97:8006/api2/json
ABYSSE_PVE_JETON=abysse@pve!lecture=<secret affiché>
ABYSSE_PVE_CA=/etc/abysse/pve-ca.pem
ABYSSE_PVE_NOEUD=<nom du nœud, celui que donne la commande hostname sur l'hôte>
```

Abysse appelle Proxmox par son IP et vérifie le certificat avec l'autorité interne de
Proxmox. On la copie dans le CT depuis l'hôte :

```
pct push 150 /etc/pve/pve-root-ca.pem /etc/abysse/pve-ca.pem --perms 644
```

### MikroTik (RouterOS 7)

Un groupe qui ne peut que lire par l'API REST, et un utilisateur limité à l'adresse du CT :

```
/user group add name=lecture-rest policy=read,api,rest-api
/user add name=abysse group=lecture-rest address=192.168.10.169/32 password="<mot de passe long>"
```

Le service `www` (ou `www-ssl`) du routeur doit être actif. Dans `abysse.env` :

```
ABYSSE_MIKROTIK_URL=http://192.168.10.198/rest
ABYSSE_MIKROTIK_USER=abysse
ABYSSE_MIKROTIK_PASS=<mot de passe>
```

Abysse lit les interfaces toutes les 2 s, et les ressources, l'ARP, les baux DHCP et la
table du pont toutes les 30 s. RouterOS garde une petite partie des sessions REST ouvertes :
ce rythme a été choisi pour ne pas l'encombrer.

### Onduleur (NUT)

Abysse parle directement au serveur NUT (`upsd`), sans compte, avec la commande
`LIST VAR`. Sur la machine où l'onduleur est branché, `upsd` doit écouter sur le réseau
local, dans `/etc/nut/upsd.conf` :

```
LISTEN 0.0.0.0 3493
```

Puis dans `abysse.env`, avec le nom de l'onduleur tel qu'il est écrit dans `ups.conf` :

```
ABYSSE_NUT_HOTE=192.168.10.97
ABYSSE_NUT_UPS=onduleur
```

### InfluxDB 2

Abysse lit deux buckets : `homelab` et `proxmox`. Un jeton en lecture sur les deux :

```
influx bucket list
influx auth create --org homelab --read-bucket <ID de homelab> --read-bucket <ID de proxmox> --description "abysse, lecture"
```

```
ABYSSE_INFLUX_URL=http://192.168.10.55:8086
ABYSSE_INFLUX_JETON=<jeton>
ABYSSE_INFLUX_ORG=homelab
```

Ce qu'Abysse y cherche (tout est facultatif, il prend ce qu'il trouve) :

| Bucket | Mesure | Contenu | Sert à |
| :-- | :-- | :-- | :-- |
| homelab | `monitor_status` | sondes Uptime Kuma lues par Telegraf (plugin `prometheus` sur `/metrics` de Kuma), tag `monitor_name` | état de la box, du PBS, du NAS et de tout ce qui n'est vu que par Kuma ; sondes `backup-*` pour les sauvegardes ratées |
| homelab | `synology` | champs `raid_total_size`, `raid_free_size`, `system_status` | jauge du NAS Synology |
| homelab | `zfs_pool_etat` | tags `host=pbs` et `pool`, champs `size`, `alloc`, `health` | jauge du serveur de sauvegarde |
| homelab | `upsd` | plugin `upsd` de Telegraf, champ `input_voltage` | coupures de courant passées dans la frise |
| proxmox | `system` | serveur de métriques InfluxDB de Proxmox (champ `uptime`, tags `vmid`, `object`) | pannes passées des CT et VM dans la frise |

Les noms des sondes Kuma se règlent dans l'inventaire (clé `kuma`, étape 5).

Pour `zfs_pool_etat`, un petit script lancé par Telegraf (`inputs.exec`) sur le PBS suffit :

```
#!/bin/sh
zpool list -Hp -o name,size,alloc,health | while read -r nom taille alloue sante; do
  echo "zfs_pool_etat,pool=$nom size=${taille}i,alloc=${alloue}i,health=\"$sante\""
done
```

Le premier démarrage d'Abysse (base vide) relit les 30 derniers jours dans InfluxDB pour
remplir la frise tout de suite.

### TrueNAS

TrueNAS récent n'a plus d'API REST : Abysse utilise l'API JSON-RPC en WebSocket
(`/api/current`) et s'authentifie par SCRAM-SHA-512. La clé d'API ne circule jamais,
seule une preuve dérivée part, liée au certificat du serveur.

1. Dans l'interface de TrueNAS : Identifiants, Utilisateurs, ajouter un utilisateur
   `abysse` sans mot de passe ni shell, avec le rôle « Read-Only Admin ».
2. Créer une clé d'API pour cet utilisateur. Elle a la forme `<id>-<secret>`.
3. TrueNAS a en général un certificat auto-signé : on l'épingle dans le CT.

```
openssl s_client -connect 192.168.10.31:443 </dev/null 2>/dev/null | openssl x509 > /etc/abysse/truenas.pem
chmod 644 /etc/abysse/truenas.pem
```

```
ABYSSE_TRUENAS_URL=https://192.168.10.31
ABYSSE_TRUENAS_UTILISATEUR=abysse
ABYSSE_TRUENAS_CLE=<id>-<secret>
ABYSSE_TRUENAS_CA=/etc/abysse/truenas.pem
```

Si le certificat de TrueNAS change, il faut refaire l'étape 3. Abysse lit l'état et la
place des pools toutes les 2 minutes ; le nom du pool affiché se règle dans l'inventaire
(`pool_truenas`).

### Phare (facultatif)

Si [Phare](https://github.com/tom-lion38/phare) tourne sur le réseau, Abysse peut lui
demander la liste des sites, lue en direct dans le Caddyfile :

```
ABYSSE_PHARE_URL=http://192.168.10.110
```

Elle est relue toutes les 10 minutes et à chaque clic sur « Actualiser ».

## 4. Les sites

Sans Phare, Abysse lit les sites dans `/etc/abysse/sites.json`, fabriqué une fois à partir
du Caddyfile. Depuis l'hôte Proxmox, si Caddy tourne dans le CT 110 :

```
pct exec 110 -- cat /etc/caddy/Caddyfile > /tmp/Caddyfile
pct push 150 /tmp/Caddyfile /tmp/Caddyfile
pct exec 150 -- bash -c 'cd /opt/abysse && python3 -m abysse.sites /tmp/Caddyfile > /etc/abysse/sites.json && rm /tmp/Caddyfile'
rm /tmp/Caddyfile
```

Chaque site est accroché à la machine qui le sert (d'après l'adresse du `reverse_proxy`).
Un site dont l'amont est inconnu est accroché au CT de Caddy, retrouvé par son adresse
(`ip_caddy_public` dans l'inventaire).

## 5. L'inventaire

Tout ce qui ne se découvre pas par les API est décrit dans `/etc/abysse/inventaire.json`
(chemin donné par `ABYSSE_INVENTAIRE`). Le fichier d'exemple décrit un homelab type : on
l'adapte, on retire ce qu'on n'a pas. Seul le MikroTik (`mikrotik`) est obligatoire, c'est
le centre de la carte.

Chaque équipement a sept champs :

| Champ | Exemple | Rôle |
| :-- | :-- | :-- |
| `nom` | `"NAS Synology"` | nom affiché |
| `type` | `"nas"` | forme et taille du point : `routeur`, `box`, `internet`, `hyperviseur`, `sauvegarde`, `nas`, `domotique`, `switch`, `onduleur`, `pc`, `appareil` |
| `groupe` | `"synology"` | couleur : `mikrotik`, `internet`, `pve`, `pbs`, `synology`, `truenas`, `onduleur`, `ha`, `reseau`, `appareils` |
| `parent` | `"mikrotik"` | à quoi il est branché (`null` pour le MikroTik) |
| `niveau` | `1` | 0 pour le routeur, 1 branché dessus, 2 derrière |
| `ip` | `"192.168.10.253"` | sert à le reconnaître dans l'ARP et à accrocher les sites |
| `url` | `"https://nas.lan:5001"` | lien ouvert au clic, ou `null` |

Les identifiants `box`, `internet`, `pve`, `pbs`, `synology` et `onduleur` ont un
traitement à part (débit WAN, jauges, batterie) : on garde ces noms-là pour ces rôles.

Les autres clés :

| Clé | Rôle |
| :-- | :-- |
| `ports_fixes` | ports du MikroTik connus d'avance, par équipement (par exemple un bond sur deux ports pour l'hyperviseur) |
| `port_wan` | port du MikroTik vers la box |
| `ip_vm` | IP de repli pour les VM dont la configuration Proxmox ne donne pas l'adresse |
| `ip_caddy_public` | adresse du CT Caddy |
| `kuma` | identifiant de l'équipement vers nom de la sonde Uptime Kuma |
| `supervision_seule` | équipements dont l'état ne vient que de Kuma (ceux derrière la box, par exemple) |
| `eteints_expres` | équipements gris au lieu de rouges au premier lancement (modifiable ensuite dans l'interface) |
| `prefixe_sauvegarde` | préfixe des sondes Kuma « push » des sauvegardes |
| `vm_speciales` | VM avec un rôle particulier, par exemple `{"200": ["nas-vm", "truenas"]}` pour une VM TrueNAS |
| `url_invites` | lien d'interface pour certains invités |
| `pool_truenas` | pool TrueNAS à afficher en jauge |

Après chaque modification : `systemctl restart abysse`. Un fichier invalide empêche le
démarrage avec un message clair dans `journalctl -u abysse`.

## 6. Le pare-feu

`deploy/nftables.conf` n'ouvre le port 80 qu'au réseau local et au VPN, et SSH qu'au
réseau local. On adapte les deux listes en haut du fichier, puis :

```
bash deploy/installer.sh --pare-feu
```

## 7. Mettre à jour

```
cd /root/abysse
git pull
bash deploy/installer.sh
```

La configuration n'est jamais écrasée. La version précédente reste dans
`/opt/abysse.ancien` : pour revenir en arrière, on remet ce dossier à la place de
`/opt/abysse` et on redémarre le service.

## 8. En cas de souci

- `systemctl status abysse` et `journalctl -u abysse -f` : chaque source qui échoue y est
  nommée, sans jamais afficher de secret.
- `curl http://127.0.0.1/api/sante` dans le CT : état de chaque source (`ok`, `erreur`).
- Une machine en gris bleuté veut dire « source muette », pas « en panne ».
- Pour tester l'interface sans toucher à rien : `python3 -m abysse --demo --port 8080`.
