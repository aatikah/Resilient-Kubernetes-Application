FROM nginx:1.27-alpine

RUN addgroup -S -g 10001 app \
    && adduser -S -D -H -u 10001 -G app app \
    && chown -R 10001:10001 /usr/share/nginx/html /etc/nginx/conf.d

COPY nginx.conf /etc/nginx/nginx.conf
COPY default.conf /etc/nginx/conf.d/default.conf
COPY --chown=10001:10001 public/ /usr/share/nginx/html/

USER 10001:10001
EXPOSE 8080
