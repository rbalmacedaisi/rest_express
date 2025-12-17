#!/bin/bash

# Copiar los certificados renovados
cp /etc/letsencrypt/live/lms.isi.edu.pa/privkey.pem /home/ubuntu/odoo-proxy/certs/
cp /etc/letsencrypt/live/lms.isi.edu.pa/fullchain.pem /home/ubuntu/odoo-proxy/certs/

# Asegurar que los permisos son correctos
chown ubuntu:ubuntu /home/ubuntu/odoo-proxy/certs/*.pem
chmod 644 /home/ubuntu/odoo-proxy/certs/*.pem

# Reiniciar el servicio de odoo-proxy
pm2 restart odoo-proxy