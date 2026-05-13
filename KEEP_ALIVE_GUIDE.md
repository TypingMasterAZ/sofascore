# Serveri 24/7 Oyaq Saxlama Bələdçisi (External Keep-Alive)

Render-in pulsuz planında server 15 dəqiqə hərəkətsizlikdən sonra yuxuya gedir. Daxili sistemlər bəzən bunu tam həll edə bilmir. Ən etibarlı yol xaricdən bir monitorinq xidməti qoşmaqdır.

## 1. Cron-job.org (Tövsiyə olunan - Pulsuz)

Bu sayt hər dəqiqə serverinizə zəng vuraraq onu oyaq saxlayacaq.

1.  [Cron-job.org](https://cron-job.org/en/) saytında pulsuz qeydiyyatdan keçin.
2.  **"Create Cronjob"** düyməsini sıxın.
3.  **Title:** `ProScore KeepAlive`
4.  **URL:** `https://sofascore-xoyr.onrender.com/api/keepalive-v2?source=cron-job-org`
5.  **Schedule:** "Every 1 minute" seçin.
6.  **Create** düyməsini sıxın.

## 2. UptimeRobot (Alternativ)

Əgər Cron-job xoşunuza gəlməsə, bunu yoxlayın:

1.  [UptimeRobot](https://uptimerobot.com/) saytına daxil olun.
2.  **"Add New Monitor"** seçin.
3.  **Monitor Type:** `HTTP(s)`
4.  **Friendly Name:** `ProScore Live`
5.  **URL (or IP):** `https://sofascore-xoyr.onrender.com/api/ping?source=uptimerobot`
6.  **Monitoring Interval:** "Every 5 minutes" (Pulsuz versiyada minimum 5 dəqiqədir).

## Necə yoxlamalı?

Serveriniz işə düşəndən sonra Render-in **Logs** bölməsinə baxın. Orada hər dəqiqə belə yazılar görməlisiniz:

`[PING] Received from: cron-job-org at ...`
və ya
`[KEEPALIVE-V2] Aggressive ping from: cron-job-org`

Bu yazıları görürsünüzsə, deməli serveriniz heç vaxt yuxuya getməyəcək!
