ARG BUILD_FROM
FROM ${BUILD_FROM}

# The panel is built ahead (app/www); the add-on only needs Node to serve it and run its services.
RUN apk add --no-cache nodejs

COPY app /app
COPY run.sh /run.sh
RUN chmod a+x /run.sh

CMD [ "/run.sh" ]
