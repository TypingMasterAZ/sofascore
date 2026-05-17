# Oracle Always Free Deploy

Bu layiheni Oracle Cloud Always Free VPS-de 24/7 isletmek ucun qisa yol xeritesidir.

## 1. Oracle VM yarat

1. Oracle Cloud hesabina daxil ol.
2. Compute > Instances > Create instance.
3. Image: Ubuntu 22.04 ve ya Ubuntu 24.04, Always Free eligible.
4. Shape: imkan varsa `VM.Standard.A1.Flex`; yoxdursa `VM.Standard.E2.1.Micro` da baslamaq ucun olar.
5. A1 Flex secende 1 OCPU / 6 GB RAM kifayetdir. E2.1.Micro secende 1 GB RAM oldugu ucun script avtomatik 2 GB swap yaradacaq.
6. Public subnet sec ve public IPv4 aktiv olsun.
7. SSH private key-i yukle ve saxla.

Oracle panelinde VCN Security List ve ya NSG-de bu ingress portlari ac:

- TCP 22: SSH
- TCP 80: HTTP
- TCP 443: HTTPS

## 2. Servere SSH ile gir

```bash
ssh -i /path/to/oracle-key.key ubuntu@YOUR_PUBLIC_IP
```

Eger Windows PowerShell-den girirsen:

```powershell
ssh -i C:\path\to\oracle-key.key ubuntu@YOUR_PUBLIC_IP
```

## 3. Node, PM2 ve Caddy qur

Repo serverde olandan sonra bu scripti islede bilersen. Ilk defe repo hele yoxdursa, komandalari elle kopyala.

```bash
curl -fsSL https://raw.githubusercontent.com/TypingMasterAZ/sofascore/main/scripts/oracle-install.sh -o oracle-install.sh
chmod +x oracle-install.sh
./oracle-install.sh
```

## 4. Layiheni servere yukle

```bash
sudo mkdir -p /var/www/rabona-media
sudo chown -R ubuntu:ubuntu /var/www/rabona-media
git clone https://github.com/TypingMasterAZ/sofascore.git /var/www/rabona-media
cd /var/www/rabona-media
npm ci --omit=dev
cp .env.oracle.example .env
nano .env
```

`.env` icinde en vacib deyisenler:

```bash
PUBLIC_URL=https://YOUR_DOMAIN
KEEPALIVE_ENABLED=false
LIVE_SCORE_POLL_INTERVAL_MS=2500
WEB_PUSH_SUBJECT=mailto:support@your-domain.com
```

## 5. HTTPS domen sec

iPhone PWA push ucun HTTPS mecburidir. Sadece `http://IP:3000` ile bildiris stabil islemeyecek.

Professional yol:

1. Domen al ve ya movcud domeninden subdomain yarat: `live.yourdomain.com`.
2. DNS-de A record elave et: `live -> YOUR_PUBLIC_IP`.
3. Caddy avtomatik HTTPS sertifikat alacaq.

Pulsuz test yolu:

IP-ni domen kimi istifade et:

```text
YOUR_PUBLIC_IP.sslip.io
```

Meselen IP `129.80.10.20` olsa:

```text
129.80.10.20.sslip.io
```

Bu test ucun rahatdir, amma real sayt ucun oz domen daha dogrudur.

## 6. Caddy reverse proxy qur

```bash
sudo cp /var/www/rabona-media/deploy/oracle/Caddyfile.example /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
```

`YOUR_DOMAIN` yerini real domenle evez et:

```caddy
live.yourdomain.com {
  encode zstd gzip
  reverse_proxy 127.0.0.1:3000
}
```

Sonra:

```bash
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager
```

## 7. Sayti PM2 ile 24/7 baslat

```bash
cd /var/www/rabona-media
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

`pm2 startup` sana uzun `sudo env ...` komandasi verecek. Onu oldugu kimi kopyalayib islet.

## 8. Yoxla

```bash
curl -I https://YOUR_DOMAIN
curl https://YOUR_DOMAIN/api/push/status
pm2 logs rabona-media --lines 80
```

Brauzerde ac:

```text
https://YOUR_DOMAIN
```

iPhone-da:

1. Yeni Oracle domenini Safari-de ac.
2. Share > Add to Home Screen.
3. Home Screen-den app-i ac.
4. Bildiris icazesini ver.
5. Favorit oyun sec.

Render domeninde yaradilan kohne Home Screen app Oracle domeni ucun push ala bilmez. Yeni domen/origin ucun PWA-ni yeniden elave etmek lazimdir.

## 9. Sonra update etmek

```bash
cd /var/www/rabona-media
git pull
npm ci --omit=dev
pm2 restart rabona-media --update-env
pm2 logs rabona-media --lines 80
```
